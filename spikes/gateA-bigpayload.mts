/**
 * 闸门 A spike(P0 字节级流水线版):2/5/10/20MB 真实数据链路实测。
 * 运行:cd apps/worker && npx tsx ../../spikes/gateA-bigpayload.mts
 *
 * 本地 workerd(getPlatformProxy)+ 真实 HTTP mock 上游,驱动与生产完全相同的
 * 分阶段流水线(start → scan → decode → assemble),逐档输出耗时/队列调用次数/字节数。
 * 注意:本地 workerd 不强制 10ms CPU 限额;本 spike 证明「可行性与正确性」,
 * 线上每阶段真实 CPU 由 spikes/live-cpu-probe 实测(见 docs/FEASIBILITY.md)。
 */
import { getPlatformProxy } from "wrangler";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleQueueBatch } from "../apps/worker/src/queues/imageConsumer";
import { startMockUpstream, type MockUpstream } from "../apps/worker/test/mockUpstream";

const here = dirname(fileURLToPath(import.meta.url));

async function setup() {
  const proxy = await getPlatformProxy({ configPath: "./wrangler.test.jsonc", persist: false });
  const env = proxy.env as Record<string, any>;
  env.SESSION_SECRET = "spike-secret-0123456789abcdef0123456789abcdef";
  env.OTP_SECRET = "spike-otp-secret-0123456789abcdef0123456789abcdef";
  const migDir = join(here, "../db/migrations");
  for (const f of readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migDir, f), "utf-8").replace(/^--.*$/gm, "");
    for (const stmt of sql.split(/;\s*\n/)) {
      if (stmt.trim()) await env.DB.prepare(stmt.trim()).run();
    }
  }
  return { env, dispose: proxy.dispose };
}

function makePngLike(bytes: number): Uint8Array {
  const buf = new Uint8Array(bytes);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(buf.buffer);
  view.setUint32(8, 13);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 2048);
  view.setUint32(20, 1152);
  let seed = 12345;
  for (let i = 24; i < bytes; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = seed & 0xff;
  }
  return buf;
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

async function runCase(env: any, upstream: MockUpstream, sizeMB: number): Promise<boolean> {
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, email, display_name, role, status, created_at) VALUES (?, ?, ?, 'teacher', 'active', ?)")
    .bind(userId, `spike-${sizeMB}@example.edu`, "Spike", new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO projects (id, owner_id, title, status, version_seq, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)")
    .bind(projectId, userId, "Spike", new Date().toISOString(), new Date().toISOString()).run();

  const png = makePngLike(sizeMB * 1024 * 1024);
  upstream.setNextImageResponse({
    data: [{ b64_json: toB64(png) }],
    size: "2048x2048",
    output_format: "png",
  });

  const jobId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO messages (id, project_id, author_id, role, content, kind, attachments, meta, created_at) VALUES (?, ?, ?, 'user', 'spike', 'generation', '[]', '{}', ?)")
    .bind(messageId, projectId, userId, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO generation_jobs (id, project_id, user_id, message_id, status, model, prompt, mode, reference_ids, params, created_at) VALUES (?, ?, ?, ?, 'queued', 'gpt-image-2.6-flare', 'spike', 'generate', '[]', ?, ?)")
    .bind(jobId, projectId, userId, messageId, JSON.stringify({ size_preset: "1:1" }), new Date().toISOString()).run();

  const t0 = performance.now();
  let pumps = 0;
  let status = "";
  for (let i = 0; i < 500; i++) {
    pumps++;
    await handleQueueBatch(queueBatch([jobId]), env);
    const row = await env.DB.prepare("SELECT status FROM generation_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
    status = row?.status || "";
    if (["succeeded", "failed", "uncertain", "interrupted", "pending_save"].includes(status)) break;
  }
  const t1 = performance.now();
  const job = await env.DB.prepare("SELECT status FROM generation_jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
  const ver = await env.DB.prepare("SELECT size_bytes, rel_path FROM versions WHERE project_id = ?").bind(projectId).first<{ size_bytes: number; rel_path: string }>();
  let bytesOk = false;
  if (ver) {
    const obj = await env.MEDIA.get(ver.rel_path);
    const stored = new Uint8Array(await obj!.arrayBuffer());
    bytesOk = stored.byteLength === sizeMB * 1024 * 1024 && stored[0] === 0x89;
  }
  const ok = job?.status === "succeeded" && bytesOk;
  console.log(`${String(sizeMB).padStart(3)} MB | 总耗时 ${Math.round(t1 - t0)} ms | 队列调用 ${pumps} 次 | job=${job?.status} | 字节=${ver ? ver.size_bytes : 0} | ${ok ? "OK" : "MISMATCH"}`);
  return ok;
}

const { env, dispose } = await setup();
const upstream = await startMockUpstream();
env.AI_BASE_URL = upstream.url + "/v1";
env.GEN = { send: async () => {} };
console.log("=== 闸门 A spike(P0 字节级流水线):capture→scan→decode→assemble ===");
let allOk = true;
for (const mb of [2, 5, 10, 20]) {
  allOk = (await runCase(env, upstream, mb)) && allOk;
}
console.log(allOk ? "结果:全部通过(本地 workerd,分阶段流水线)" : "结果:存在失败项");
await upstream.close();
await dispose();
process.exit(allOk ? 0 : 1);
