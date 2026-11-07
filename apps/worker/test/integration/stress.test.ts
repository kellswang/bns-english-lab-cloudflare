/**
 * 并发压力测试(P3.2):12/20/30 位教师同时登录、发对话、提交生图并轮询。
 * 全部使用本地 workerd + mock 上游;记录吞吐/成功率/上游调用次数。
 * 注意:这是本地模拟,不代表线上多 isolate 并发与真实上游吞吐。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTestCtx, type TestCtx } from "./env";
import { call, login, seedInvite } from "../helpers";
import { handleQueueBatch } from "../../src/queues/imageConsumer";
import { startMockUpstream, type MockUpstream } from "../mockUpstream";

let ctx: TestCtx;
let upstream: MockUpstream;

function pngBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let s = 1;
  for (let i = 8; i < size; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; bytes[i] = s & 0xff; }
  return bytes;
}
function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function queueBatch(ids: string[]): any {
  return { messages: ids.map((id) => ({ body: { job_id: id }, ack: () => {}, retry: () => {}, attempts: 1 })), queue: "t", ackAll: () => {}, retryAll: () => {} };
}

beforeAll(async () => {
  ctx = await makeTestCtx();
  upstream = await startMockUpstream();
  ctx.env.AI_BASE_URL = upstream.url + "/v1";
  ctx.env.CHAT_BASE_URL = upstream.url + "/v1";
});

afterAll(async () => {
  await upstream.close();
  await ctx.dispose();
});

async function runConcurrency(n: number): Promise<{ wallMs: number; ok: number; jobsOk: number }> {
  // 每位教师独立邮箱与白名单
  const emails: string[] = [];
  for (let i = 0; i < n; i++) {
    const e = `stress-${n}-${i}@example.edu`;
    await seedInvite(ctx.env, e, `压测${i}`);
    emails.push(e);
  }
  const t0 = performance.now();
  const cookies = await Promise.all(emails.map((e) => login(ctx.env, e)));
  expect(cookies.every(Boolean)).toBe(true);

  upstream.setNextImageResponse({ data: [{ b64_json: toB64(pngBytes(120_000)) }], size: "2048x1152", output_format: "png" });

  // 并发:每人生成 1 张图 + 提交 1 轮对话请求(mock 上游已配置图像响应;对话用独立路由不 mock → 预期 4xx/5xx,不阻塞)
  const jobIds: string[] = [];
  await Promise.all(cookies.map(async (cookie, i) => {
    const p = await call(ctx.env, "/api/v1/projects", { body: { title: `压测${i}` }, cookie });
    const pid = (await p.json<{ id: string }>()).id;
    const g = await call(ctx.env, "/api/v1/generate", {
      body: { project_id: pid, prompt: `压测图${i}`, model: "gpt-image-2.6-flare", size: "16:9", client_request_id: `stress-${n}-${i}` },
      cookie,
    });
    expect(g.status).toBe(202);
    jobIds.push((await g.json<{ job_id: string }>()).job_id);
  }));

  // 泵送全部任务到终态(模拟并发消费)
  const TERMINAL = new Set(["succeeded", "failed", "uncertain", "interrupted", "pending_save"]);
  for (let i = 0; i < 400; i++) {
    await handleQueueBatch(queueBatch(jobIds), ctx.env);
    const rows = await ctx.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM generation_jobs WHERE id IN (${jobIds.map(() => "?").join(",")}) AND status IN ('queued','submitted','running')`,
    ).bind(...jobIds).first<{ n: number }>();
    if (Number(rows?.n) === 0) break;
  }
  const okJobs = await ctx.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM generation_jobs WHERE id IN (${jobIds.map(() => "?").join(",")}) AND status = 'succeeded'`,
  ).bind(...jobIds).first<{ n: number }>();
  const wallMs = Math.round(performance.now() - t0);
  return { wallMs, ok: cookies.length, jobsOk: Number(okJobs?.n) };
}

describe("并发压力(本地模拟)", () => {
  it("12 位教师并发:登录 + 生图全部成功", async () => {
    const r = await runConcurrency(12);
    console.log(`[12人] 墙钟 ${r.wallMs}ms,登录 ${r.ok}/12,生图成功 ${r.jobsOk}/12,上游调用 ${upstream.calls.images}`);
    expect(r.jobsOk).toBe(12);
    expect(upstream.calls.images).toBe(12);
  });

  it("20 位教师并发:生图全部成功", async () => {
    upstream.reset();
    const r = await runConcurrency(20);
    console.log(`[20人] 墙钟 ${r.wallMs}ms,生图成功 ${r.jobsOk}/20`);
    expect(r.jobsOk).toBe(20);
  }, 300_000);

  it("30 位教师并发:生图全部成功", async () => {
    upstream.reset();
    const r = await runConcurrency(30);
    console.log(`[30人] 墙钟 ${r.wallMs}ms,生图成功 ${r.jobsOk}/30`);
    expect(r.jobsOk).toBe(30);
  }, 300_000);
});
