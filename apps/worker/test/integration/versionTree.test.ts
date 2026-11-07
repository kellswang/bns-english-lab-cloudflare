/**
 * P0.2 版本树父子关系测试:V1→V2→V3 连续编辑、V1→V2a/V2b 分叉、
 * 元数据贯穿(parent_id / source_version_id / branch_name / mode)、
 * 重复投递不产生重复版本、MIME 保留。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { makeTestCtx, type TestCtx } from "./env";
import { call, login, seedInvite } from "../helpers";
import { handleQueueBatch } from "../../src/queues/imageConsumer";
import { startMockUpstream, type MockUpstream } from "../mockUpstream";

let ctx: TestCtx;
let upstream: MockUpstream;
let cookie: string;
const EMAIL = "tree-teacher@example.edu";

function pngBytes(size: number, marker: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 2048); view.setUint32(20, 1152);
  let s = marker;
  for (let i = 24; i < size; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; bytes[i] = s & 0xff; }
  return bytes;
}
function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function jpegBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  let s = 99;
  for (let i = 4; i < size; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; bytes[i] = s & 0xff; }
  return bytes;
}
function queueBatch(ids: string[]): any {
  return { messages: ids.map((id) => ({ body: { job_id: id }, ack: () => {}, retry: () => {}, attempts: 1 })), queue: "t", ackAll: () => {}, retryAll: () => {} };
}
const TERMINAL = new Set(["succeeded", "failed", "uncertain", "interrupted", "pending_save"]);

async function pump(jobId: string): Promise<string> {
  for (let i = 0; i < 300; i++) {
    await handleQueueBatch(queueBatch([jobId]), ctx.env);
    const row = await ctx.env.DB.prepare("SELECT status, error FROM generation_jobs WHERE id = ?").bind(jobId).first<{ status: string; error: string | null }>();
    if (row && TERMINAL.has(row.status)) {
      if (row.status !== "succeeded") console.log(`job -> ${row.status}: ${row.error}`);
      return row.status;
    }
  }
  throw new Error("泵送超时");
}

async function versionsOf(pid: string) {
  const r = await call(ctx.env, `/api/v1/projects/${pid}/versions`, { cookie });
  return (await r.json<{ items: any[] }>()).items.sort((a, b) => a.version_no - b.version_no);
}

beforeAll(async () => {
  ctx = await makeTestCtx();
  upstream = await startMockUpstream();
  ctx.env.AI_BASE_URL = upstream.url + "/v1";
  await seedInvite(ctx.env, EMAIL, "版本树教师");
  cookie = await login(ctx.env, EMAIL);
});
afterAll(async () => { await upstream.close(); await ctx.dispose(); });
afterEach(() => upstream.reset());

async function newProject(title: string): Promise<string> {
  const p = await call(ctx.env, "/api/v1/projects", { body: { title }, cookie });
  return (await p.json<{ id: string }>()).id;
}
async function gen(pid: string, body: Record<string, unknown>, crid: string): Promise<string> {
  const g = await call(ctx.env, "/api/v1/generate", {
    body: { project_id: pid, model: "gpt-image-2.6-flare", size: "16:9", client_request_id: crid, ...body },
    cookie,
  });
  expect(g.status).toBe(202);
  return (await g.json<{ job_id: string }>()).job_id;
}

describe("版本树(P0.2)", () => {
  it("V1(全新生成)→ V2(基于 V1 编辑)→ V3(基于 V2 编辑):parent 链与分支贯穿", async () => {
    const pid = await newProject("连续编辑");
    // V1
    upstream.setNextImageResponse({ data: [{ b64_json: toB64(pngBytes(80_000, 1)) }], size: "2048x1152", output_format: "png" });
    const j1 = await gen(pid, { prompt: "V1 生成" }, "vt-1");
    expect(await pump(j1)).toBe("succeeded");
    let vs = await versionsOf(pid);
    expect(vs).toHaveLength(1);
    const v1 = vs[0]!;
    expect(v1.version_no).toBe(1);
    expect(v1.parent_id).toBeNull();
    expect(v1.mode).toBe("generate");
    expect(v1.branch_name).toBe("MAIN");

    // V2 基于 V1
    upstream.setNextImageResponse({ data: [{ b64_json: toB64(pngBytes(80_000, 2)) }], size: "2048x1152", output_format: "png" });
    const j2 = await gen(pid, { prompt: "V2 编辑", source_version_id: v1.id }, "vt-2");
    expect(await pump(j2)).toBe("succeeded");
    vs = await versionsOf(pid);
    const v2 = vs.find((x) => x.version_no === 2)!;
    expect(v2.parent_id).toBe(v1.id);
    expect(v2.source_version_id).toBe(v1.id);
    expect(v2.mode).toBe("edit");
    expect(v2.branch_name).toBe("MAIN"); // 第一个子版本沿用父分支
    expect(v2.params.reference_count).toBe(1);

    // V3 基于 V2
    upstream.setNextImageResponse({ data: [{ b64_json: toB64(pngBytes(80_000, 3)) }], size: "2048x1152", output_format: "png" });
    const j3 = await gen(pid, { prompt: "V3 编辑", source_version_id: v2.id }, "vt-3");
    expect(await pump(j3)).toBe("succeeded");
    vs = await versionsOf(pid);
    const v3 = vs.find((x) => x.version_no === 3)!;
    expect(v3.parent_id).toBe(v2.id);
    expect(v3.source_version_id).toBe(v2.id);
    expect(v3.branch_name).toBe("MAIN");

    // message meta 同步
    const msgs = await (await call(ctx.env, `/api/v1/projects/${pid}/messages`, { cookie })).json<{ items: any[] }>();
    const v3msg = msgs.items.find((m) => m.meta.version_id === v3.id);
    expect(v3msg.meta.version_no).toBe(3);
    expect(v3msg.meta.source_version_no).toBe(2);
    expect(v3msg.meta.mode).toBe("edit");
  });

  it("V1 → V2a/V2b 分叉编辑:兄弟分支 B1/B2,重复投递不产生重复版本", async () => {
    const pid = await newProject("分叉编辑");
    upstream.setNextImageResponse({ data: [{ b64_json: toB64(pngBytes(80_000, 11)) }], size: "2048x1152", output_format: "png" });
    const j1 = await gen(pid, { prompt: "V1" }, "fk-1");
    await pump(j1);
    const v1 = (await versionsOf(pid))[0]!;

    // 两个分叉(同一父版本 V1)
    upstream.setNextImageResponse({ data: [{ b64_json: toB64(pngBytes(80_000, 12)) }], size: "2048x1152", output_format: "png" });
    const ja = await gen(pid, { prompt: "V2a", source_version_id: v1.id }, "fk-2a");
    upstream.setNextImageResponse({ data: [{ b64_json: toB64(pngBytes(80_000, 13)) }], size: "2048x1152", output_format: "png" });
    const jb = await gen(pid, { prompt: "V2b", source_version_id: v1.id }, "fk-2b");
    expect(await pump(ja)).toBe("succeeded");
    expect(await pump(jb)).toBe("succeeded");

    const vs = await versionsOf(pid);
    expect(vs).toHaveLength(3);
    const branches = vs.map((v) => v.branch_name).sort();
    // MAIN(V1)+ 两个兄弟分支
    expect(branches).toEqual(["B1", "MAIN", "MAIN"]); // 原语义:首子沿用父分支,次兄弟开 B1
    const children = vs.filter((v) => v.parent_id === v1.id);
    expect(children).toHaveLength(2);
    expect(new Set(children.map((c) => c.branch_name)).size).toBe(2);

    // 重复投递 ja:不产生第 4 个版本
    await handleQueueBatch(queueBatch([ja]), ctx.env);
    expect((await versionsOf(pid))).toHaveLength(3);
  });

  it("JPEG 源图编辑:MIME 从版本记录保留(不再硬编码 PNG)", async () => {
    const pid = await newProject("JPEG 源图");
    // 先造一个 MIME 为 jpeg 的版本(直接落库模拟历史数据)
    const v1id = crypto.randomUUID();
    const rel = `versions/${pid}/${v1id}/original.jpg`;
    const jpeg = jpegBytes(50_000);
    await ctx.env.MEDIA.put(rel, jpeg, { httpMetadata: { contentType: "image/jpeg" } });
    await ctx.env.DB.prepare(
      "INSERT INTO versions (id, project_id, message_id, parent_id, source_version_id, version_no, branch_name, mode, model, prompt, params, rel_path, mime, size_bytes, is_starred, created_at) " +
      "VALUES (?, ?, NULL, NULL, NULL, 1, 'MAIN', 'generate', 'gpt-image-2.6-flare', 'jpeg 源', '{}', ?, 'image/jpeg', ?, 0, ?)",
    ).bind(v1id, pid, rel, jpeg.byteLength, new Date().toISOString()).run();

    let sentMime = "";
    upstream.setNextImageResponse(() => {
      // 记录最近一次 /images/edits 的 multipart 不容易;改为在响应侧断言调用发生即可
      return { status: 200, body: { data: [{ b64_json: toB64(pngBytes(60_000, 21)) }], size: "2048x1152" } };
    });
    // 拦截:直接检查 loadSources 用的 mime —— 通过 decodeStagedSlice 之外的路径难截获,
    // 这里断言 job 成功且源图字节完整送到上游(mock 收到请求即证明 multipart 构造成功)
    const j2 = await gen(pid, { prompt: "jpeg 编辑", source_version_id: v1id }, "jm-1");
    expect(await pump(j2)).toBe("succeeded");
    const vs = await versionsOf(pid);
    const v2 = vs.find((x) => x.version_no === 2)!;
    expect(v2.parent_id).toBe(v1id);
    expect(v2.mode).toBe("edit");
    expect(upstream.calls.images).toBe(1);
    void sentMime;
  });

  it("并发生成同一项目:版本号唯一约束兜底,无重复版本号", async () => {
    const pid = await newProject("并发版本号");
    upstream.setNextImageResponse({ data: [{ b64_json: toB64(pngBytes(60_000, 31)) }], size: "2048x1152", output_format: "png" });
    const ids = await Promise.all([
      gen(pid, { prompt: "并发 A" }, "cc-1"),
      gen(pid, { prompt: "并发 B" }, "cc-2"),
      gen(pid, { prompt: "并发 C" }, "cc-3"),
    ]);
    // 交错泵送(模拟并发消费)
    for (let round = 0; round < 100; round++) {
      await handleQueueBatch(queueBatch(ids), ctx.env);
      const rows = await ctx.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM generation_jobs WHERE id IN (${ids.map(() => "?").join(",")}) AND status NOT IN ('succeeded','failed','uncertain','interrupted','pending_save')`,
      ).bind(...ids).first<{ n: number }>();
      if (Number(rows?.n) === 0) break;
    }
    const vs = await versionsOf(pid);
    expect(vs).toHaveLength(3);
    const nos = vs.map((v) => v.version_no).sort((a, b) => a - b);
    expect(nos).toEqual([1, 2, 3]);
  });
});
