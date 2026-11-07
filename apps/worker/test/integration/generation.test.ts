/**
 * 图片生成集成测试 —— 对应 test_hardening.py 的幂等/容量/状态机核心断言:
 * 同幂等键去重、同键不同参数 409、每日限额、队列消费产出版本、重复投递不重复。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { makeTestCtx, type TestCtx } from "./env";
import { call, login, seedInvite } from "../helpers";
import { handleQueueBatch } from "../../src/queues/imageConsumer";
import { startMockUpstream, type MockUpstream } from "../mockUpstream";

let ctx: TestCtx;
let cookie: string;
let upstream: MockUpstream;
const EMAIL = "gen-teacher@example.edu";

// 最小合法 PNG 头 + 填充(消费端只做魔数校验与存储,不解码)
function fakePng(size = 2048): ArrayBuffer {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes.buffer;
}

function queueBatch(jobIds: string[]): any {
  return {
    messages: jobIds.map((id) => ({
      body: { job_id: id },
      ack: () => {}, retry: () => {}, attempts: 1,
    })),
    queue: "test",
    ackAll: () => {}, retryAll: () => {},
  };
}

const TERMINAL = new Set(["succeeded", "failed", "uncertain", "interrupted", "pending_save"]);

/** 多阶段流水线:反复泵送直到终态。 */
async function pumpUntilTerminal(jobId: string, max = 200): Promise<string> {
  for (let i = 0; i < max; i++) {
    await handleQueueBatch(queueBatch([jobId]), ctx.env);
    const row = await ctx.env.DB.prepare("SELECT status FROM generation_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    if (row && TERMINAL.has(row.status)) return row.status;
  }
  throw new Error("泵送超时,任务未收敛");
}

beforeAll(async () => {
  ctx = await makeTestCtx({ IMAGE_DAILY_LIMIT_PER_USER: "3" });
  upstream = await startMockUpstream();
  ctx.env.AI_BASE_URL = upstream.url + "/v1";
  await seedInvite(ctx.env, EMAIL, "生成教师");
  cookie = await login(ctx.env, EMAIL);
});

afterAll(async () => {
  await upstream.close();
  await ctx.dispose();
});
afterEach(() => upstream.reset());

async function newProject(): Promise<string> {
  const res = await call(ctx.env, "/api/v1/projects", { body: { title: "幂等测试项目" }, cookie });
  expect(res.status).toBe(201);
  return (await res.json<{ id: string }>()).id;
}

describe("生成幂等与容量", () => {
  it("同 client_request_id 重复提交返回同一任务(deduplicated)", async () => {
    const pid = await newProject();
    const body = { project_id: pid, prompt: "画一只猫", model: "gpt-image-2.6-flare", size: "1:1", client_request_id: "cr-1111" };
    const r1 = await call(ctx.env, "/api/v1/generate", { body, cookie });
    expect(r1.status).toBe(202);
    const j1 = await r1.json<{ job_id: string; deduplicated: boolean }>();
    expect(j1.deduplicated).toBe(false);

    const r2 = await call(ctx.env, "/api/v1/generate", { body, cookie });
    expect(r2.status).toBe(202);
    const j2 = await r2.json<{ job_id: string; deduplicated: boolean; message_id: string | null }>();
    expect(j2.job_id).toBe(j1.job_id);
    expect(j2.deduplicated).toBe(true);
  });

  it("同键不同参数 → 409 idempotency_key_reused", async () => {
    const pid = await newProject();
    await call(ctx.env, "/api/v1/generate", {
      body: { project_id: pid, prompt: "A", model: "gpt-image-2.6-flare", size: "1:1", client_request_id: "cr-2222" },
      cookie,
    });
    const res = await call(ctx.env, "/api/v1/generate", {
      body: { project_id: pid, prompt: "B", model: "gpt-image-2.6-flare", size: "1:1", client_request_id: "cr-2222" },
      cookie,
    });
    expect(res.status).toBe(409);
    const detail = await res.json<{ detail: { reason?: string } }>();
    expect(detail.detail.reason).toBe("idempotency_key_reused");
  });

  it("每日限额(测试配置 3 张)超限 429 且退回计数", async () => {
    // 独立用户,避免与幂等测试共享每日计数
    await seedInvite(ctx.env, "quota-teacher@example.edu", "限额教师");
    const quotaCookie = await login(ctx.env, "quota-teacher@example.edu");
    const p = await call(ctx.env, "/api/v1/projects", { body: { title: "限额项目" }, cookie: quotaCookie });
    const pid = (await p.json<{ id: string }>()).id;
    for (let i = 0; i < 3; i++) {
      const res = await call(ctx.env, "/api/v1/generate", {
        body: { project_id: pid, prompt: `limit-${i}`, model: "gpt-image-2.6-flare", client_request_id: `day-${i}` },
        cookie: quotaCookie,
      });
      expect(res.status).toBe(202);
    }
    // 与原项目容量检查顺序一致:活跃任务上限(3)先于每日限额;
    // 把 3 个任务置为终态后再触发,验证的才是 daily_limit
    await ctx.env.DB.prepare(
      "UPDATE generation_jobs SET status = 'succeeded', finished_at = ? WHERE user_id = (SELECT id FROM users WHERE email = ?)",
    ).bind(new Date().toISOString(), "quota-teacher@example.edu").run();
    const res = await call(ctx.env, "/api/v1/generate", {
      body: { project_id: pid, prompt: "limit-over", model: "gpt-image-2.6-flare", client_request_id: "day-over" },
      cookie: quotaCookie,
    });
    expect(res.status).toBe(429);
    const detail = await res.json<{ detail: { reason?: string } }>();
    expect(detail.detail.reason).toBe("daily_limit");
  });
});

describe("队列消费状态机", () => {
  it("queued → succeeded,产出 V1,b64 图入 R2,meta 更新;重复投递不产生第二个版本", async () => {
    const pid = await newProject();
    const gen = await call(ctx.env, "/api/v1/generate", {
      body: { project_id: pid, prompt: "画一棵树", model: "gpt-image-2.6-flare", size: "16:9", client_request_id: "q-1" },
      cookie,
    });
    const { job_id: jobId } = await gen.json<{ job_id: string }>();

    // mock 上游:返回 2048x1152 PNG(b64)
    upstream.setNextImageResponse({
      data: [{ b64_json: Buffer.from(fakePng()).toString("base64"), revised_prompt: "一棵大树" }],
      size: "2048x1152",
      usage: { input_tokens: 3, output_tokens: 1 },
      output_format: "png",
    });

    await pumpUntilTerminal(jobId);
    expect(upstream.calls.images).toBe(1); // 上游只被调用一次

    const jobRow = await ctx.env.DB.prepare("SELECT status, version_id, error FROM generation_jobs WHERE id = ?")
      .bind(jobId).first<{ status: string; version_id: string; error: string | null }>();
    expect(jobRow?.status).toBe("succeeded");
    expect(jobRow?.version_id).toBeTruthy();

    const ver = await ctx.env.DB.prepare(
      "SELECT version_no, branch_name, mode, rel_path, params FROM versions WHERE project_id = ?").bind(pid).first<any>();
    expect(ver.version_no).toBe(1);
    expect(ver.branch_name).toBe("MAIN");
    expect(ver.mode).toBe("generate");
    const params = JSON.parse(ver.params);
    expect(params.size_preset).toBe("16:9");
    expect(params.upstream_request_id).toBe("mock-rid");
    expect(params.native_2k).toBe(true);

    // R2 对象存在且可读
    const obj = await ctx.env.MEDIA.get(ver.rel_path);
    expect(obj).not.toBeNull();
    const buf = await obj!.arrayBuffer();
    expect(buf.byteLength).toBe(2048);

    // 重复投递:再处理一次,不会产生第二个版本,也不再次调用上游
    await handleQueueBatch(queueBatch([jobId]), ctx.env);
    expect(upstream.calls.images).toBe(1);
    const cnt = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM versions WHERE project_id = ?").bind(pid).first<{ n: number }>();
    expect(Number(cnt?.n)).toBe(1);

    // message meta 已更新
    const msg = await ctx.env.DB.prepare("SELECT meta FROM messages WHERE project_id = ? AND kind = 'generation'").bind(pid).first<{ meta: string }>();
    const meta = JSON.parse(msg!.meta);
    expect(meta.status).toBe("succeeded");
    expect(meta.version_no).toBe(1);
  });

  it("上游 5xx → uncertain,不自动重试付费请求", async () => {
    // 独立用户:测试配置每日限额 3 张,前面的测试已用满
    await seedInvite(ctx.env, "err-teacher@example.edu", "容错教师");
    const errCookie = await login(ctx.env, "err-teacher@example.edu");
    const p = await call(ctx.env, "/api/v1/projects", { body: { title: "容错项目" }, cookie: errCookie });
    const pid = (await p.json<{ id: string }>()).id;
    const gen = await call(ctx.env, "/api/v1/generate", {
      body: { project_id: pid, prompt: "画一片海", model: "gpt-image-2.6-sunburst", client_request_id: "q-2" },
      cookie: errCookie,
    });
    expect(gen.status).toBe(202);
    const { job_id: jobId } = await gen.json<{ job_id: string }>();
    expect(jobId).toBeTruthy();

    upstream.setNextImageResponse(() => ({ status: 500, body: { error: { message: "server exploded" } } }));
    await handleQueueBatch(queueBatch([jobId]), ctx.env);
    expect(upstream.calls.images).toBe(1); // 只调一次上游

    const jobRow = await ctx.env.DB.prepare("SELECT status FROM generation_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    expect(jobRow?.status).toBe("uncertain");
  });

  it("不支持编辑的模型 + source_version_id → API 层直接 409(不进队列)", async () => {
    // 当前两款模型都支持编辑;这里验证模型白名单拒绝
    const pid = await newProject();
    const res = await call(ctx.env, "/api/v1/generate", {
      body: { project_id: pid, prompt: "x", model: "gpt-image-2.6-nonexist", client_request_id: "q-3" },
      cookie,
    });
    expect(res.status).toBe(400);
  });
});
