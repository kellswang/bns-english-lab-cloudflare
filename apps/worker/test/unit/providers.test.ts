/**
 * 三家原生协议事件解析(mock fixture)—— 对应原 test_chat.py 的 provider 部分。
 * 闸门 C 的本地验证:只测协议解析,不依赖真实上游(真实额度核对见 FEASIBILITY.md)。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import type { Env } from "../../src/types";
import { streamOpenAIResponses } from "../../src/chat/providers/openaiResponses";
import { streamAnthropicMessages } from "../../src/chat/providers/anthropicMessages";
import { streamGoogleGemini } from "../../src/chat/providers/googleGemini";
import { getChatModel } from "../../src/chat/capabilities";
import type { ChatRequest } from "../../src/chat/providers/base";

const env = {
  CHAT_BASE_URL: "https://ai-mock.test/v1",
  CHAT_API_KEY: "k",
  AI_API_KEY: "k",
  AI_BASE_URL: "https://ai-mock.test/v1",
} as unknown as Env;

function sseResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

function fakeReq(transport: string): ChatRequest {
  const model = getChatModel(
    transport === "openai" ? "gpt-6.1-sol" :
    transport === "anthropic" ? "claude-sonnet-5-5" : "gemini-3.8-flash",
  )!;
  return {
    model,
    thinking: {},
    system: "sys",
    messages: [{ role: "user", text: "你好", images: [] }],
    max_output_tokens: 4096,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI Responses 事件流", () => {
  it("delta/meta/usage/done 与 request_id 优先响应头", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(
      [
        'data: {"type":"response.created","response":{"id":"resp_x","model":"gpt-6.1-sol"}}',
        'data: {"type":"response.output_text.delta","delta":"你"}',
        'data: {"type":"response.output_text.delta","delta":"好"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15,"input_tokens_details":{"cached_tokens":2},"output_tokens_details":{"reasoning_tokens":1}}}}',
        "data: [DONE]",
      ].join("\n\n") + "\n\n",
      { "x-request-id": "rid-header" },
    )));
    const events = [];
    for await (const ev of streamOpenAIResponses(env, fakeReq("openai"))) events.push(ev);
    expect(events.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("你好");
    const meta = events.find((e) => e.type === "meta") as any;
    expect(meta.request_id).toBe("rid-header");
    const usage = events.find((e) => e.type === "usage") as any;
    expect(usage.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, cached_tokens: 2, reasoning_tokens: 1 });
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  it("响应头缺 x-request-id 时用 response.id 兜底", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(
      'data: {"type":"response.created","response":{"id":"resp_fallback"}}\n\n' +
      'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
      "data: [DONE]\n\n",
    )));
    const events = [];
    for await (const ev of streamOpenAIResponses(env, fakeReq("openai"))) events.push(ev);
    expect((events.find((e) => e.type === "meta") as any).request_id).toBe("resp_fallback");
  });

  it("response.failed → error 事件", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(
      'data: {"type":"response.failed","response":{"error":{"message":"boom"}}}\n\ndata: [DONE]\n\n',
    )));
    const events = [];
    for await (const ev of streamOpenAIResponses(env, fakeReq("openai"))) events.push(ev);
    expect(events.some((e) => e.type === "error" && /boom/.test((e as any).message))).toBe(true);
  });
});

describe("Anthropic Messages 事件流", () => {
  it("thinking_delta 不下发,text_delta 下发,usage 汇总", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(
      [
        'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":8,"cache_read_input_tokens":3}}}',
        'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hidden-chain"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"teacher"}}',
        'data: {"type":"message_delta","usage":{"output_tokens":7}}',
        "data: [DONE]",
      ].join("\n\n") + "\n\n",
      { "x-request-id": "rid-a" },
    )));
    const events = [];
    for await (const ev of streamAnthropicMessages(env, fakeReq("anthropic"))) events.push(ev);
    const text = events.filter((e) => e.type === "text").map((e) => (e as any).delta).join("");
    expect(text).toBe("Hello teacher");
    expect(text).not.toContain("hidden-chain");
    const usage = events.find((e) => e.type === "usage") as any;
    expect(usage.usage).toMatchObject({ prompt_tokens: 8, cached_tokens: 3, completion_tokens: 7, total_tokens: 15 });
  });

  it("错误事件中断流", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(
      'data: {"type":"error","error":{"message":"overloaded"}}\n\ndata: [DONE]\n\n',
    )));
    const events = [];
    for await (const ev of streamAnthropicMessages(env, fakeReq("anthropic"))) events.push(ev);
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });
});

describe("Google Gemini 事件流", () => {
  it("文本/usage 正常;responseId 在流末尾仍作为 meta 落库", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(
      [
        'data: {"candidates":[{"content":{"parts":[{"text":"早上"}]}}]}',
        'data: {"candidates":[{"content":{"parts":[{"text":"好"}]}}]}',
        'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":9,"candidatesTokenCount":4,"totalTokenCount":13,"cachedContentTokenCount":0,"thoughtsTokenCount":2},"responseId":"g-rid"}',
      ].join("\n\n") + "\n\n",
    )));
    const events = [];
    for await (const ev of streamGoogleGemini(env, fakeReq("gemini"))) events.push(ev);
    expect(events.filter((e) => e.type === "text").map((e) => (e as any).delta).join("")).toBe("早上好");
    const usage = events.find((e) => e.type === "usage") as any;
    expect(usage.usage).toMatchObject({ prompt_tokens: 9, completion_tokens: 4, reasoning_tokens: 2 });
    // meta 在 usage 之后(流末补发)
    const metaIdx = events.findIndex((e) => e.type === "meta");
    const usageIdx = events.findIndex((e) => e.type === "usage");
    expect(metaIdx).toBeGreaterThan(usageIdx);
    expect((events[metaIdx] as any).request_id).toBe("g-rid");
  });

  it("上游 error 对象 → error 事件", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse(
      'data: {"error":{"code":503,"message":"UNAVAILABLE","status":"UNAVAILABLE"}}\n\n',
    )));
    const events = [];
    for await (const ev of streamGoogleGemini(env, fakeReq("gemini"))) events.push(ev);
    const err = events.find((e) => e.type === "error") as any;
    expect(err).toBeTruthy();
    expect(err.retryable).toBe(true);
  });
});
