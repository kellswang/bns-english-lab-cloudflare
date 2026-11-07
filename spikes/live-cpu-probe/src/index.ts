// live-cpu-probe:部署到真实 Cloudflare Free 账户,实测 HTTP / Queues / Cron 三通道 CPU。
// 详见同目录 README-LIVE.md。所有路由幂等,可反复触发。
import { startImageUpstream, decodeAsciiB64, allowedImageUrl } from "../../apps/worker/src/providers/imageGateway";
import { writeStreamToChunks, assembleChunks } from "../../apps/worker/src/providers/imgpipe";

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  PROBE: Queue<{ n: number }>;
}

const encoder = new TextEncoder();

async function ensurePayload(env: Env, mb: number): Promise<{ b64Key: string; b64Len: number; chunks: number }> {
  const key = `probe/payload-${mb}.b64`;
  const head = await env.MEDIA.head(key);
  if (head) {
    const meta = await env.DB.prepare("SELECT chunks FROM probe_meta WHERE key = ?").bind(key).first<{ chunks: number }>();
    return { b64Key: key, b64Len: Math.round(head.size), chunks: meta?.chunks ?? Math.ceil(Number(head.size) / 500_000) };
  }
  // 生成 mb MB 伪随机 PNG 头数据(仅 setup 时做一次,setup 本身不计入验收)
  const bytes = new Uint8Array(mb * 1024 * 1024);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let seed = 42;
  for (let i = 8; i < bytes.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = seed & 0xff;
  }
  // 分块 base64 编码(避免一次性大字符串拼接的内存峰值)
  const b64Len = Math.ceil(bytes.length / 3) * 4;
  const out = new Uint8Array(b64Len);
  let pos = 0;
  const CH = 3 * 32767; // 3 字节对齐
  for (let i = 0; i < bytes.length; i += CH) {
    const slice = bytes.subarray(i, Math.min(i + CH, bytes.length));
    const bin = String.fromCharCode(...slice);
    const enc = encoder.encode(btoa(bin));
    out.set(enc, pos);
    pos += enc.length;
  }
  // 存为分块对象(与生产 b64 暂存一致)
  const prefix = `probe/payload-${mb}`;
  let chunks = 0;
  for (let i = 0; i < pos; i += 500_000) {
    await env.MEDIA.put(`${prefix}/${chunks}`, out.subarray(i, Math.min(i + 500_000, pos)), { httpMetadata: { contentType: "text/plain" } });
    chunks++;
  }
  await env.MEDIA.put(key, out.subarray(0, 0).length === 0 ? new ArrayBuffer(0) : out.slice(0, 0)); // 占位避免误用
  await env.MEDIA.delete(key);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS probe_meta (key TEXT PRIMARY KEY, chunks INTEGER)").run();
  await env.DB.prepare("INSERT INTO probe_meta (key, chunks) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET chunks = excluded.chunks")
    .bind(prefix, chunks).run();
  return { b64Key: prefix, b64Len: pos, chunks };
}

async function measure(name: string, fn: () => Promise<void>): Promise<Response> {
  const t0 = performance.now();
  await fn();
  const wallMs = Math.round(performance.now() - t0);
  return Response.json({ probe: name, wall_ms: wallMs, note: "cpu_time_ms 由 wrangler tail --format json 的 cpuTime 字段读取" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const mb = Math.min(20, Math.max(1, Number(url.searchParams.get("mb") || 10)));

    if (url.pathname === "/setup") {
      const p = await ensurePayload(env, mb);
      return Response.json({ ok: true, ...p });
    }

    // 路径 1:传统整图 b64(JSON.parse 全量 + atob 全量)—— 预期在大图时超 10ms
    if (url.pathname === "/probe/b64-inline") {
      const { b64Key, chunks } = await ensurePayload(env, mb);
      return measure(`b64-inline-${mb}MB`, async () => {
        const parts: string[] = [];
        for (let i = 0; i < chunks; i++) {
          const obj = await env.MEDIA.get(`${b64Key}/${i}`);
          parts.push(new TextDecoder().decode(await obj!.arrayBuffer()));
        }
        const bytes = decodeAsciiB64(parts.join(""));
        await env.MEDIA.put(`probe/out/b64-inline-${mb}`, bytes, { httpMetadata: { contentType: "image/png" } });
      });
    }

    // 路径 2:流水线单片(atob 500K 字符)—— 生产 decode 阶段每次调用的真实成本
    if (url.pathname === "/probe/slice") {
      const { b64Key } = await ensurePayload(env, mb);
      return measure(`slice-${mb}MB`, async () => {
        const obj = await env.MEDIA.get(`${b64Key}/0`);
        const text = new TextDecoder().decode(await obj!.arrayBuffer());
        const bytes = decodeAsciiB64(text);
        await env.MEDIA.put(`probe/out/slice-${mb}`, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
      });
    }

    // 路径 3:流式扫描窗口(1MB 字节级 marker 扫描)—— scan 阶段单次成本
    if (url.pathname === "/probe/scan") {
      const { b64Key } = await ensurePayload(env, mb);
      return measure(`scan-${mb}MB`, async () => {
        const obj = await env.MEDIA.get(`${b64Key}/0`);
        const data = new Uint8Array(await obj!.arrayBuffer());
        const marker = new TextEncoder().encode('"b64_json":"');
        let hits = 0;
        for (let s = 0; s <= data.length - marker.length; s++) {
          let m = true;
          for (let k = 0; k < marker.length; k++) {
            if (data[s + k] !== marker[k]) { m = false; break; }
          }
          if (m) hits++;
        }
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS probe_scan (ts TEXT, hits INTEGER)").run();
        await env.DB.prepare("INSERT INTO probe_scan (ts, hits) VALUES (?, ?)").bind(new Date().toISOString(), hits).run();
      });
    }

    // 路径 4:纯 I/O 合成(两个 5MB 分块 → 单对象)
    if (url.pathname === "/probe/assemble") {
      await ensurePayload(env, Math.min(mb, 10));
      return measure(`assemble-${mb}MB`, async () => {
        await assembleChunks(env, `probe/payload-${Math.min(mb, 10)}`, 20, 10 * 1024 * 1024, `probe/out/assemble-${mb}`, "application/octet-stream");
      });
    }

    // 路径 5:Queues 通道 — 入队一个 slice 解码,由 consumer 执行
    if (url.pathname === "/probe/queue") {
      await ensurePayload(env, mb);
      await env.PROBE.send({ n: mb });
      return Response.json({ ok: true, note: "等待 consumer 执行;结果见 probe_queue 表,cpuTime 用 wrangler tail 读取" });
    }

    if (url.pathname === "/probe/results") {
      const rows = await env.DB.prepare("SELECT * FROM probe_queue ORDER BY rowid DESC LIMIT 20").all();
      return Response.json({ ok: true, rows: rows.results ?? [] });
    }

    return Response.json({
      ok: true,
      routes: ["/setup?mb=N", "/probe/b64-inline?mb=N", "/probe/slice?mb=N", "/probe/scan?mb=N", "/probe/assemble?mb=N", "/probe/queue?mb=N", "/probe/results"],
    });
  },

  async queue(batch: MessageBatch<{ n: number }>, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const { b64Key } = await ensurePayload(env, msg.body.n);
      const obj = await env.MEDIA.get(`${b64Key}/0`);
      const text = new TextDecoder().decode(await obj!.arrayBuffer());
      const bytes = decodeAsciiB64(text);
      await env.MEDIA.put(`probe/out/queue-${msg.body.n}`, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS probe_queue (ts TEXT, n INTEGER, bytes INTEGER)").run();
      await env.DB.prepare("INSERT INTO probe_queue (ts, n, bytes) VALUES (?, ?, ?)").bind(new Date().toISOString(), msg.body.n, bytes.byteLength).run();
      msg.ack();
    }
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil((async () => {
      const { b64Key } = await ensurePayload(env, 10);
      const obj = await env.MEDIA.get(`${b64Key}/0`);
      const text = new TextDecoder().decode(await obj!.arrayBuffer());
      const bytes = decodeAsciiB64(text);
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS probe_cron (ts TEXT, bytes INTEGER)").run();
      await env.DB.prepare("INSERT INTO probe_cron (ts, bytes) VALUES (?, ?)").bind(new Date().toISOString(), bytes.byteLength).run();
    })());
  },
} satisfies ExportedHandler<Env>;
