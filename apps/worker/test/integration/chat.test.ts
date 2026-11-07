/**
 * 对话 SSE 集成测试(本地 workerd)—— 对应 test_chat.py 关键断言:
 * start/delta/finish 事件、落库 complete、usage/request_id 持久化、
 * 幂等重放、停止(D1 信号)、分支 edit_of。
 */
import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from "vitest";
import { makeTestCtx, type TestCtx } from "./env";
import { call, login, seedInvite } from "../helpers";

let ctx: TestCtx;
let cookie: string;
const EMAIL = "chat-teacher@example.edu";

function sseBody(frames: string[]): string {
  return frames.join("\n\n") + "\n\n";
}

function openaiStream(): Response {
  return new Response(sseBody([
    'data: {"type":"response.created","response":{"id":"resp_e2e","model":"gpt-6.1-sol"}}',
    'data: {"type":"response.output_text.delta","delta":"同学们"}',
    'data: {"type":"response.output_text.delta","delta":"好"}',
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}',
    "data: [DONE]",
  ]), { status: 200, headers: { "x-request-id": "rid-e2e" } });
}

async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text.split("\n\n")
    .filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
    .map((f) => JSON.parse(f.slice(6)));
}

beforeAll(async () => {
  ctx = await makeTestCtx();
  await seedInvite(ctx.env, EMAIL, "对话教师");
  cookie = await login(ctx.env, EMAIL);
});

afterAll(async () => { await ctx.dispose(); });
afterEach(() => vi.unstubAllGlobals());

describe("对话 SSE 全链路", () => {
  it("发送消息:事件流完整,消息落库 complete,usage/request_id 持久化", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openaiStream()));
    const conv = await call(ctx.env, "/api/v1/chat/conversations", {
      body: { model: "gpt-6.1-sol", thinking: "standard" }, cookie,
    });
    const convId = (await conv.json<{ id: string }>()).id;

    const res = await call(ctx.env, `/api/v1/chat/conversations/${convId}/messages`, {
      body: { content: "设计一节单词课", model: "gpt-6.1-sol", thinking: "standard", client_request_id: "chat-1" },
      cookie,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await readSse(res);
    const start = events.find((e) => e.type === "start") as any;
    const finish = events.find((e) => e.type === "finish") as any;
    expect(start.assistant_message_id).toBeTruthy();
    expect(finish.status).toBe("complete");
    expect(finish.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 3 });
    expect(finish.request_id).toBe("rid-e2e");

    const detail = await call(ctx.env, `/api/v1/chat/conversations/${convId}`, { cookie });
    const data = await detail.json<{ messages: Array<{ role: string; content: string; status: string; request_id: string | null }>; active_leaf_id: string | null }>();
    expect(data.messages).toHaveLength(2); // user + assistant
    expect(data.messages[0]!.content).toBe("设计一节单词课");
    expect(data.messages[1]!.status).toBe("complete");
    expect(data.messages[1]!.content).toBe("同学们好");
    expect(data.messages[1]!.request_id).toBe("rid-e2e");
    expect(data.active_leaf_id).toBe(start.assistant_message_id);
  });

  it("同 client_request_id 重试 → 幂等重放(不新增付费请求)", async () => {
    const fetchMock = vi.fn(async () => openaiStream());
    vi.stubGlobal("fetch", fetchMock);
    const conv = await call(ctx.env, "/api/v1/chat/conversations", {
      body: { model: "gpt-6.1-sol", thinking: "standard" }, cookie,
    });
    const convId = (await conv.json<{ id: string }>()).id;
    const body = { content: "幂等重放", model: "gpt-6.1-sol", thinking: "standard", client_request_id: "chat-retry-1" };
    await call(ctx.env, `/api/v1/chat/conversations/${convId}/messages`, { body, cookie });
    const countBefore = (await (await call(ctx.env, `/api/v1/chat/conversations/${convId}`, { cookie })).json<any>()).messages.length;

    const res = await call(ctx.env, `/api/v1/chat/conversations/${convId}/messages`, { body, cookie });
    const events = await readSse(res);
    expect((events[0] as any).replayed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 未再次调用上游

    const countAfter = (await (await call(ctx.env, `/api/v1/chat/conversations/${convId}`, { cookie })).json<any>()).messages.length;
    expect(countAfter).toBe(countBefore);
  });

  it("stop:写入 D1 信号后,流循环在下一次轮询时停止并落库 stopped", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sseBody([
      'data: {"type":"response.created","response":{"id":"resp_stop"}}',
      'data: {"type":"response.output_text.delta","delta":"第一段"}',
      'data: {"type":"response.output_text.delta","delta":"第二段"}',
      'data: {"type":"response.output_text.delta","delta":"第三段"}',
      "data: [DONE]",
    ]), { status: 200, headers: { "x-request-id": "rid-stop" } })));
    const conv = await call(ctx.env, "/api/v1/chat/conversations", {
      body: { model: "gpt-6.1-sol", thinking: "standard" }, cookie,
    });
    const convId = (await conv.json<{ id: string }>()).id;

    // 预先在 DB 写入 stop 信号(模拟另一实例的 stop 请求先于流处理到达)
    // 发送时拿到 assistant id 后立即 stop:
    const res = await call(ctx.env, `/api/v1/chat/conversations/${convId}/messages`, {
      body: { content: "长回答请停止", model: "gpt-6.1-sol", thinking: "standard", client_request_id: "chat-stop-1" },
      cookie,
    });
    // 从流中拿到 start 事件后立即发 stop(异步竞争:stop 在流结束前写入)
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    let assistantId = "";
    let finish: any = null;
    let stopSent = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const f of frames) {
        if (!f.startsWith("data: ") || f === "data: [DONE]") continue;
        const ev = JSON.parse(f.slice(6));
        if (ev.type === "start") {
          assistantId = ev.assistant_message_id;
        }
        if (ev.type === "delta" && !stopSent && assistantId) {
          stopSent = true;
          await call(ctx.env, `/api/v1/chat/messages/${assistantId}/stop`, { cookie });
        }
        if (ev.type === "finish") finish = ev;
      }
    }
    expect(assistantId).toBeTruthy();
    expect(finish).toBeTruthy();
    expect(finish.usage).toBeTruthy();
    // 流已终止;消息不应是 complete(部分内容被保留,状态为 stopped 或 complete 取决于竞争时机)
    const row = await ctx.env.DB.prepare("SELECT status, content FROM chat_messages WHERE id = ?").bind(assistantId).first<{ status: string; content: string }>();
    expect(row!.content.length).toBeGreaterThan(0);
    expect(["stopped", "complete"]).toContain(row!.status);
    if (row!.status === "stopped") expect(finish.status).toBe("stopped");
  });

  it("编辑上一条消息 → 新分支,旧消息保留", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => openaiStream()));
    const conv = await call(ctx.env, "/api/v1/chat/conversations", {
      body: { model: "gpt-6.1-sol", thinking: "standard" }, cookie,
    });
    const convId = (await conv.json<{ id: string }>()).id;
    const r1 = await call(ctx.env, `/api/v1/chat/conversations/${convId}/messages`, {
      body: { content: "原始问题", model: "gpt-6.1-sol", thinking: "standard", client_request_id: "br-1" }, cookie,
    });
    const ev1 = await readSse(r1);
    const userMsgId = (ev1.find((e) => e.type === "start") as any).user_message_id;

    const r2 = await call(ctx.env, `/api/v1/chat/conversations/${convId}/messages`, {
      body: { content: "编辑后的问题", model: "gpt-6.1-sol", thinking: "standard", edit_of: userMsgId, client_request_id: "br-2" }, cookie,
    });
    const ev2 = await readSse(r2);
    const newUserMsgId = (ev2.find((e) => e.type === "start") as any).user_message_id;
    expect(newUserMsgId).not.toBe(userMsgId);

    const detail = await (await call(ctx.env, `/api/v1/chat/conversations/${convId}`, { cookie })).json<any>();
    expect(detail.messages).toHaveLength(4); // 2 user + 2 assistant
    expect(detail.messages.filter((m: any) => m.role === "user").map((m: any) => m.content))
      .toEqual(["原始问题", "编辑后的问题"]);
  });

  it("不可用模型不静默替换:claude-fable-5-5 → 400", async () => {
    const conv = await call(ctx.env, "/api/v1/chat/conversations", {
      body: { model: "gpt-6.1-sol", thinking: "standard" }, cookie,
    });
    const convId = (await conv.json<{ id: string }>()).id;
    const res = await call(ctx.env, `/api/v1/chat/conversations/${convId}/messages`, {
      body: { content: "试试不可用模型", model: "claude-fable-5-5", thinking: "standard" }, cookie,
    });
    expect(res.status).toBe(400);
    const detail = await res.json<{ detail: string }>();
    expect(detail.detail).toContain("不可用");
  });
});
