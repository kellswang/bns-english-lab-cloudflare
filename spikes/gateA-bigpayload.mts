/**
 * 闸门 A spike:大体积 base64 图片响应 → 解码 → R2 写入 → D1 版本落库 的本地实测。
 * 运行:npx tsx spikes/gateA-bigpayload.mjs
 *
 * 方法:用 getPlatformProxy 起本地 workerd(与生产同运行时),mock 上游返回
 * 指定体积的 PNG 头 b64 响应,直接驱动队列消费者 processJob,测量各环节耗时。
 * 注意:本地 workerd 无 CPU 限额,这验证的是「可行性与内存行为」,
 * 线上 10ms CPU 限额的真实表现仍需授权部署后实测(FEASIBILITY.md 如实标注)。
 */
import { getPlatformProxy } from "wrangler";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { processJob } from "../apps/worker/src/queues/imageConsumer";

const here = dirname(fileURLToPath(import.meta.url));

async function setup() {
  const proxy = await getPlatformProxy({ configPath: "../worker/wrangler.test.jsonc", persist: false });
  const env = proxy.env;
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

function makePngLike(bytes: number): ArrayBuffer {
  const buf = new Uint8Array(bytes);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // 填充伪随机内容,避免全零被压缩类优化掩盖
  let seed = 12345;
  for (let i = 8; i < bytes; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    buf[i] = seed & 0xff;
  }
  return buf.buffer;
}

async function runCase(env: any, sizeMB: number) {
  const userId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO users (id, email, display_name, role, status, created_at) VALUES (?, ?, ?, 'teacher', 'active', ?)",
  ).bind(userId, `spike-${sizeMB}@example.edu`, "Spike", new Date().toISOString()).run();
  await env.DB.prepare(
    "INSERT INTO projects (id, owner_id, title, status, version_seq, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?)",
  ).bind(projectId, userId, "Spike", new Date().toISOString(), new Date().toISOString()).run();

  const png = makePngLike(sizeMB * 1024 * 1024);
  const b64 = Buffer.from(png).toString("base64");
  const jobId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO messages (id, project_id, author_id, role, content, kind, attachments, meta, created_at) VALUES (?, ?, ?, 'user', 'spike', 'generation', '[]', '{}', ?)",
  ).bind(messageId, projectId, userId, new Date().toISOString()).run();
  await env.DB.prepare(
    "INSERT INTO generation_jobs (id, project_id, user_id, message_id, status, model, prompt, mode, reference_ids, params, created_at) VALUES (?, ?, ?, ?, 'queued', 'gpt-image-2.6-flare', 'spike', 'generate', '[]', ?, ?)",
  ).bind(jobId, projectId, userId, messageId, JSON.stringify({ size_preset: "1:1" }), new Date().toISOString()).run();

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      data: [{ b64_json: b64, revised_prompt: "spike" }],
      size: "2048x2048",
      output_format: "png",
      usage: { output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "spike-rid" } });
  }) as typeof fetch;

  try {
    const t0 = performance.now();
    await processJob(env, jobId);
    const t1 = performance.now();
    const job = await env.DB.prepare("SELECT status, error FROM generation_jobs WHERE id = ?").bind(jobId).first();
    const ver = await env.DB.prepare("SELECT size_bytes, version_no FROM versions WHERE project_id = ?").bind(projectId).first();
    const ok = job.status === "succeeded" && ver && ver.size_bytes === sizeMB * 1024 * 1024;
    console.log(`${String(sizeMB).padStart(3)} MB | 总耗时 ${Math.round(t1 - t0)} ms | job=${job.status} | 落库字节=${ver ? ver.size_bytes : 0} | ${ok ? "OK" : "MISMATCH"}`);
    return ok;
  } finally {
    globalThis.fetch = origFetch;
  }
}

const { env, dispose } = await setup();
console.log("=== 闸门 A spike:大体积 b64 → 解码 → R2 → D1(本地 workerd)===");
let allOk = true;
for (const mb of [2, 5, 10, 20]) {
  allOk = (await runCase(env, mb)) && allOk;
}
console.log(allOk ? "结果:全部通过(本地 workerd)" : "结果:存在失败项");
await dispose();
process.exit(allOk ? 0 : 1);
