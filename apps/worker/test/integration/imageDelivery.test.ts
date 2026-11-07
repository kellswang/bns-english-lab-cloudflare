/**
 * 三路径交付集成测试(workerd 真实 R2 + 本地 mock 上游服务器):
 *   b64-inline(小图)/ b64-staged(大图,跨队列分片解码)/ url(流式直传)。
 * 队列消息在测试中手动泵送(handleQueueBatch),与生产同一处理函数。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { makeTestCtx, type TestCtx } from "./env";
import { call, login, seedInvite } from "../helpers";
import { handleQueueBatch } from "../../src/queues/imageConsumer";
import { startMockUpstream, type MockUpstream } from "../mockUpstream";

let ctx: TestCtx;
let upstream: MockUpstream;

function pngBytes(size: number, w = 2048, h = 1152): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 0x0000000d);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, w);
  view.setUint32(20, h);
  let s = 77;
  for (let i = 24; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = s & 0xff;
  }
  return bytes;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function queueBatch(jobIds: string[]): any {
  return {
    messages: jobIds.map((id) => ({ body: { job_id: id }, ack: () => {}, retry: () => {}, attempts: 1 })),
    queue: "test", ackAll: () => {}, retryAll: () => {},
  };
}

const TERMINAL = new Set(["succeeded", "failed", "uncertain", "interrupted", "pending_save"]);

/** 反复泵送队列直到任务终态(多阶段流水线需要多次)。 */
async function pumpUntilTerminal(jobId: string, max = 300): Promise<string> {
  for (let i = 0; i < max; i++) {
    await handleQueueBatch(queueBatch([jobId]), ctx.env);
    const row = await ctx.env.DB.prepare("SELECT status, error FROM generation_jobs WHERE id = ?").bind(jobId).first<{ status: string; error: string | null }>();
    if (row && TERMINAL.has(row.status)) {
      if (row.status !== "succeeded") console.log(`job ${jobId} -> ${row.status}: ${row.error}`);
      return row.status;
    }
  }
  throw new Error("泵送超时,任务未收敛");
}

beforeAll(async () => {
  ctx = await makeTestCtx();
  upstream = await startMockUpstream();
  ctx.env.AI_BASE_URL = upstream.url + "/v1";
});

afterAll(async () => {
  await upstream.close();
  await ctx.dispose();
});
afterEach(() => upstream.reset());

async function freshUser(label: string): Promise<string> {
  const email = `${label}@example.edu`;
  await seedInvite(ctx.env, email, label);
  return login(ctx.env, email);
}

async function newProject(title: string, userCookie: string): Promise<string> {
  const p = await call(ctx.env, "/api/v1/projects", { body: { title }, cookie: userCookie });
  return (await p.json<{ id: string }>()).id;
}

async function createJob(pid: string, prompt: string, crid: string, userCookie: string, model = "gpt-image-2.6-flare"): Promise<string> {
  const g = await call(ctx.env, "/api/v1/generate", {
    body: { project_id: pid, prompt, model, size: "16:9", client_request_id: crid },
    cookie: userCookie,
  });
  expect(g.status).toBe(202);
  return (await g.json<{ job_id: string }>()).job_id;
}

describe("b64-inline(小图)路径", () => {
  it("小图单次解码 → 单对象写入,字节一致,记录 deliver_mode", async () => {
    const uc = await freshUser("dl-inline");
    const pid = await newProject("小图交付", uc);
    const jobId = await createJob(pid, "小图测试", "dl-1", uc);
    const png = pngBytes(200_000);
    upstream.setNextImageResponse({
      data: [{ b64_json: toB64(png), revised_prompt: "小图" }],
      size: "2048x1152", output_format: "png",
      usage: { output_tokens: 2 },
    });

    const status = await pumpUntilTerminal(jobId);
    expect(status).toBe("succeeded");
    const ver = await ctx.env.DB.prepare("SELECT rel_path, params, width, height, size_bytes FROM versions WHERE project_id = ?").bind(pid).first<any>();
    const params = JSON.parse(ver.params);
    expect(params.deliver_mode).toBe("b64-inline");
    expect(params.upstream_request_id).toBe("mock-rid");
    expect(ver.width).toBe(2048);
    expect(ver.height).toBe(1152);
    expect(ver.size_bytes).toBe(200_000);
    const obj = await ctx.env.MEDIA.get(ver.rel_path);
    const stored = new Uint8Array(await obj!.arrayBuffer());
    expect(stored).toEqual(png);
  });
});

describe("b64-staged(大图)路径", () => {
  it("6MB 图 → 分窗扫描 + 分片解码 → 纯 I/O 合成,字节一致,暂存清理", async () => {
    const uc = await freshUser("dl-staged");
    const pid = await newProject("大图分块", uc);
    const jobId = await createJob(pid, "大图测试", "dl-2", uc);
    const png = pngBytes(600_000); // b64 ≈ 800K 字符 > B64_INLINE_LIMIT
    const b64 = toB64(png);
    expect(b64.length).toBeGreaterThan(500_000);
    upstream.setNextImageResponse({
      data: [{ b64_json: b64 }],
      size: "2048x1152", output_format: "png",
    });

    const status = await pumpUntilTerminal(jobId);
    expect(status).toBe("succeeded");
    const verRow = await ctx.env.DB.prepare("SELECT params FROM versions WHERE project_id = ?").bind(pid).first<{ params: string }>();
    const params = JSON.parse(verRow!.params);
    expect(params.deliver_mode).toBe("b64-staged");
    expect(params.upstream_request_id).toBe("mock-rid");

    const ver = await ctx.env.DB.prepare("SELECT rel_path, width, height, size_bytes FROM versions WHERE project_id = ?").bind(pid).first<any>();
    expect(ver.size_bytes).toBe(600_000);
    expect(ver.width).toBe(2048);
    expect(ver.height).toBe(1152);
    const obj = await ctx.env.MEDIA.get(ver.rel_path);
    const stored = new Uint8Array(await obj!.arrayBuffer());
    expect(stored).toEqual(png);
    // 暂存对象已清理
    const staging = await ctx.env.MEDIA.head(`tmp/b64/${jobId}/0`);
    expect(staging).toBeNull();
  });
});

describe("url 模式(流式直传,无 base64)", () => {
  it("有 content-length → 分块拷贝合成,字节一致", async () => {
    const uc = await freshUser("dl-url1");
    const pid = await newProject("URL直传", uc);
    const jobId = await createJob(pid, "URL测试", "dl-3", uc);
    const png = pngBytes(500_000);
    upstream.addFile("/files/abc.png", png);
    upstream.setNextImageResponse({
      data: [{ url: `${upstream.url}/files/abc.png` }],
      size: "2048x1152",
    });

    const status = await pumpUntilTerminal(jobId);
    expect(status).toBe("succeeded");
    const ver = await ctx.env.DB.prepare("SELECT rel_path, params, size_bytes FROM versions WHERE project_id = ?").bind(pid).first<any>();
    const params = JSON.parse(ver.params);
    expect(params.deliver_mode).toBe("url");
    expect(params.upstream_source).toBe("url");
    expect(ver.size_bytes).toBe(500_000);
    const obj = await ctx.env.MEDIA.get(ver.rel_path);
    const stored = new Uint8Array(await obj!.arrayBuffer());
    expect(stored).toEqual(png);
  });

  it("无 content-length → 分块拷贝路径同样正确", async () => {
    const uc = await freshUser("dl-url2");
    const pid = await newProject("URL分块", uc);
    const jobId = await createJob(pid, "URL分块测试", "dl-4", uc);
    const png = pngBytes(300_000);
    upstream.addFile("/files/no-len.png", png, { noContentLength: true });
    upstream.setNextImageResponse({
      data: [{ url: `${upstream.url}/files/no-len.png` }],
      size: "2048x1152",
    });

    const status = await pumpUntilTerminal(jobId);
    expect(status).toBe("succeeded");
    const ver = await ctx.env.DB.prepare("SELECT rel_path, size_bytes FROM versions WHERE project_id = ?").bind(pid).first<any>();
    expect(ver.size_bytes).toBe(300_000);
    const obj = await ctx.env.MEDIA.get(ver.rel_path);
    const stored = new Uint8Array(await obj!.arrayBuffer());
    expect(stored).toEqual(png);
  });

  it("URL 不在允许域内 → failed,不产生付费重试", async () => {
    const uc = await freshUser("dl-evil");
    const pid = await newProject("URL白名单", uc);
    const jobId = await createJob(pid, "白名单测试", "dl-5", uc);
    upstream.setNextImageResponse({
      data: [{ url: "https://evil.example.com/x.png" }],
    });
    const status = await pumpUntilTerminal(jobId);
    expect(status).toBe("failed");
    expect(upstream.calls.files).toBe(0); // 未发起任何下载
  });
});
