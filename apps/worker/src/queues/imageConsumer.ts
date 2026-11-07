/**
 * 图片生成任务消费者 —— P0 加固版:
 *   1) 版本树父子关系贯穿全部异步阶段(params.editCtx 携带 parent/来源/分支信息);
 *   2) 阶段级 CAS:所有进度写入用「读到的原 params」做条件更新,重复投递只有一个赢家;
 *   3) persist 领取:落库前 CAS 占位,防止两个消费者各建一个版本;
 *   4) 终态保护:markTerminal/succeeded 不覆盖已终态;
 *   5) tmp/raw 原始响应分块在 scan 完成后即删(此前大图路径泄漏);
 *   6) 源图 MIME 从版本/上传记录读取(不再硬编码 image/png)。
 *
 * 用户可见状态不变:queued / submitted / running / succeeded / failed /
 * uncertain / interrupted / pending_save。params.phase 内部阶段:
 * start → scan → deliver / decode(+assemble)→ persist。
 */
import type { Env, GenerationMessage } from "../types";
import { one, run } from "../storage/db";
import { R2Keys, sniffImageMime } from "../storage/r2";
import {
  startImageUpstream, buildEditFormData, allowedImageUrl, captureUrlToChunks,
  readImageDims, decodeAsciiB64, ImageProviderError,
} from "../providers/imageGateway";
import {
  newScanState, scanWindow, finishScan, assembleChunks, deleteChunkPrefix,
  B64_INLINE_LIMIT,
  type ScanState,
} from "../providers/imgpipe";
import { getSizePreset, nativeSizeFor } from "../domain/images";
import { loadConfig } from "../config";

const nowIso = () => new Date().toISOString();
const TERMINAL_STATES = "('succeeded','failed','uncertain','interrupted','pending_save')";

interface JobRow {
  id: string;
  project_id: string;
  user_id: string;
  message_id: string | null;
  status: string;
  model: string;
  prompt: string;
  mode: string;
  source_version_id: string | null;
  reference_ids: string;
  params: string;
}

interface EditCtx {
  /** 源版本(若有) */
  parentId: string | null;
  parentVersionNo: number | null;
  parentBranchName: string | null;
  /** 源版本 + 参考图总数(edit 模式判定与元数据) */
  sourcesCount: number;
}

interface UpstreamMeta {
  requestId: string | null;
  upstreamSize: string | null;
  revisedPrompt: string | null;
  usage: Record<string, unknown> | null;
  source: "b64" | "url";
  sizeMismatch: boolean;
}

interface JobParams {
  size_preset?: string;
  phase?: "scan" | "deliver" | "decode" | "persist";
  capture?: { kind: "chunks"; prefix: string; chunks: number; total: number };
  scan?: ScanState;
  windows?: { kind: "chunks" | "single"; total: number; next: number; key?: string; prefix?: string };
  upstream?: UpstreamMeta;
  editCtx?: EditCtx;
  url?: string;
  b64?: { prefix: string; chunks: number; bytes: number; pad: number };
  dec?: { prefix: string; chunks: number; total: number };
  outKey?: string;
  progressAt?: string;
  [k: string]: unknown;
}

function parseParams(raw: string): JobParams {
  try { return JSON.parse(raw || "{}") as JobParams; } catch { return {}; }
}

/** P0.3 阶段级 CAS:以「读到的原始 params」为条件写回;0 行受影响=别人已推进,本消息放弃。 */
async function casParams(env: Env, jobId: string, oldRaw: string, next: JobParams): Promise<boolean> {
  next.progressAt = nowIso();
  const res = await run(
    env.DB,
    "UPDATE generation_jobs SET params = ? WHERE id = ? AND params = ?",
    JSON.stringify(next), jobId, oldRaw,
  );
  return (res.meta.changes ?? 0) === 1;
}

/** CAS 前置领取:把 phase 推进到指定值;失败=别的消费者在处理,本消息直接 ack。 */
async function claimPhase(env: Env, jobId: string, oldRaw: string, params: JobParams, phase: JobParams["phase"]): Promise<JobParams | null> {
  const next: JobParams = { ...params, phase };
  const ok = await casParams(env, jobId, oldRaw, next);
  return ok ? next : null;
}

async function setMessageMeta(env: Env, messageId: string | null, fields: Record<string, unknown>): Promise<void> {
  if (!messageId) return;
  const row = await one<{ meta: string }>(env.DB, "SELECT meta FROM messages WHERE id = ?", messageId);
  if (!row) return;
  const meta = { ...JSON.parse(row.meta || "{}"), ...fields };
  await run(env.DB, "UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), messageId);
}

/** P0.3 终态保护:不覆盖已终态(重复失败路径不会互相改写)。 */
async function markTerminal(env: Env, jobId: string, status: string, message: string): Promise<void> {
  const job = await one<JobRow>(env.DB, "SELECT * FROM generation_jobs WHERE id = ?", jobId);
  if (!job) return;
  await run(
    env.DB,
    `UPDATE generation_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status NOT IN ${TERMINAL_STATES}`,
    status, message.slice(0, 600), nowIso(), jobId,
  );
  await setMessageMeta(env, job.message_id, { status, error: message.slice(0, 300) });
  await run(env.DB,
    "INSERT INTO audit_logs (id, actor_email, action, entity_id, detail, ip, created_at) VALUES (?, NULL, ?, ?, ?, NULL, ?)",
    crypto.randomUUID(), `generation_${status}`, jobId, message.slice(0, 200), nowIso());
}

async function nextBranchName(env: Env, projectId: string, parent: { id: string; branch_name: string }): Promise<string> {
  const siblings = await one<{ n: number }>(env.DB, "SELECT COUNT(*) AS n FROM versions WHERE parent_id = ?", parent.id);
  if ((siblings?.n ?? 0) === 0) return parent.branch_name;
  const used = await one<{ n: number }>(
    env.DB, "SELECT COUNT(DISTINCT branch_name) AS n FROM versions WHERE project_id = ? AND branch_name LIKE 'B%'", projectId);
  return `B${(used?.n ?? 0) + 1}`;
}

async function persistVersion(
  env: Env,
  job: JobRow,
  params: JobParams,
  out: { key: string; mime: string; size: number; dims: { width: number; height: number } | null },
): Promise<void> {
  const cfg = loadConfig(env);
  const preset = getSizePreset(String(params.size_preset || "a4"));
  const { w, h } = nativeSizeFor(preset);
  const up = params.upstream;
  const editCtx = params.editCtx ?? { parentId: null, parentVersionNo: null, parentBranchName: null, sourcesCount: 0 };
  const deliverMode = params.url !== undefined ? "url" : params.b64 ? "b64-staged" : "b64-inline";
  const versionParams = {
    size_preset: preset.id,
    size_label: preset.label,
    unit_price_usd: cfg.pricePerImageUsd,
    reference_count: editCtx.sourcesCount,
    requested_native_px: `${w}×${h}`,
    model_native_px: up?.upstreamSize ?? null,
    output_px: out.dims ? `${out.dims.width}×${out.dims.height}` : (up?.upstreamSize ?? `${w}x${h}`).replace("x", "×"),
    native_2k: up ? !up.sizeMismatch : true,
    size_mismatch: up ? Boolean(up.sizeMismatch) : false,
    was_resized: false,
    was_cropped: false,
    upstream_size: up?.upstreamSize ?? null,
    upstream_request_id: up?.requestId ?? null,
    upstream_quality: "high",
    upstream_usage: up?.usage ?? null,
    upstream_source: up?.source ?? null,
    deliver_mode: deliverMode,
  };

  const versionId = crypto.randomUUID();
  try {
    const seqRow = await one<{ version_seq: number }>(
      env.DB,
      "UPDATE projects SET version_seq = version_seq + 1, updated_at = ? WHERE id = ? RETURNING version_seq",
      nowIso(), job.project_id,
    );
    if (!seqRow) throw new Error("项目不存在");
    let versionNo = seqRow.version_seq;
    // 分支命名:P0.2 用贯穿的 editCtx(源版本存在 → 同支沿用或开 B 系列)
    const branchName = editCtx.parentId && editCtx.parentBranchName
      ? await nextBranchName(env, job.project_id, { id: editCtx.parentId, branch_name: editCtx.parentBranchName })
      : "MAIN";
    let inserted = false;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO versions (id, project_id, message_id, parent_id, source_version_id, version_no, branch_name, mode, model, prompt, revised_prompt, params, rel_path, thumb_path, width, height, mime, size_bytes, is_starred, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?)",
          ).bind(
            versionId, job.project_id, job.message_id, editCtx.parentId, job.source_version_id,
            versionNo, branchName, editCtx.sourcesCount ? "edit" : "generate", job.model, job.prompt,
            up?.revisedPrompt ?? null, JSON.stringify(versionParams), out.key,
            out.dims?.width ?? null, out.dims?.height ?? null, out.mime, out.size, nowIso(),
          ),
          env.DB.prepare(
            `UPDATE generation_jobs SET status = 'succeeded', version_id = ?, finished_at = ? WHERE id = ? AND status NOT IN ${TERMINAL_STATES}`,
          ).bind(versionId, nowIso(), job.id),
        ]);
        inserted = true;
      } catch {
        const retry = await one<{ version_seq: number }>(
          env.DB, "UPDATE projects SET version_seq = version_seq + 1 WHERE id = ? RETURNING version_seq", job.project_id);
        if (!retry) throw new Error("版本号分配失败");
        versionNo = retry.version_seq;
      }
    }
    if (!inserted) throw new Error("版本号分配重试仍失败");
    await setMessageMeta(env, job.message_id, {
      version_id: versionId, version_no: versionNo,
      model: job.model, mode: editCtx.sourcesCount ? "edit" : "generate", status: "succeeded",
    });
  } catch (e) {
    await markTerminal(env, job.id, "pending_save", `图片已返回但本地保存失败(${e instanceof Error ? e.name : "unknown"}),请稍后在版本列表确认`);
  }
}

async function loadSources(
  env: Env, job: JobRow,
): Promise<{ sources: Array<{ filename: string; mime: string; data: ArrayBuffer }>; editCtx: EditCtx; terminal: boolean }> {
  const sources: Array<{ filename: string; mime: string; data: ArrayBuffer }> = [];
  let editCtx: EditCtx = { parentId: null, parentVersionNo: null, parentBranchName: null, sourcesCount: 0 };
  if (job.source_version_id) {
    // P0.2/P1.4:MIME 从版本记录读取(此前硬编码 image/png 会破坏 JPEG/WebP 源图编辑)
    const src = await one<{ id: string; version_no: number; branch_name: string; rel_path: string; project_id: string; mime: string }>(
      env.DB, "SELECT id, version_no, branch_name, rel_path, project_id, mime FROM versions WHERE id = ?", job.source_version_id);
    if (!src || src.project_id !== job.project_id) {
      await markTerminal(env, job.id, "failed", "引用的图片版本不存在,请重新选择");
      return { sources, editCtx, terminal: true };
    }
    const obj = await env.MEDIA.get(src.rel_path);
    if (!obj) {
      await markTerminal(env, job.id, "failed", "引用的源图文件已丢失,请重新生成");
      return { sources, editCtx, terminal: true };
    }
    sources.push({ filename: `v${src.version_no}.png`, mime: src.mime || "image/png", data: await obj.arrayBuffer() });
    editCtx = { parentId: src.id, parentVersionNo: src.version_no, parentBranchName: src.branch_name, sourcesCount: 1 };
  }
  for (const refId of JSON.parse(job.reference_ids || "[]") as string[]) {
    const up = await one<{ id: string; filename: string; content_type: string; rel_path: string; project_id: string }>(
      env.DB, "SELECT id, filename, content_type, rel_path, project_id FROM uploads WHERE id = ?", refId);
    if (!up || up.project_id !== job.project_id) continue;
    const obj = await env.MEDIA.get(up.rel_path);
    if (obj) {
      sources.push({ filename: up.filename || "ref.png", mime: up.content_type || "image/png", data: await obj.arrayBuffer() });
      editCtx.sourcesCount += 1;
    }
  }
  return { sources, editCtx, terminal: false };
}

async function enqueue(env: Env, jobId: string): Promise<void> {
  try {
    await env.GEN.send({ job_id: jobId });
  } catch (e) {
    console.warn("enqueue deferred to sweep", jobId, e);
  }
}

/** scan 结束后删除 raw 捕获分块(P0.5:此前 staged 大图路径从不删除 → 泄漏)。 */
async function deleteCapture(env: Env, params: JobParams): Promise<void> {
  try {
    if (params.capture) {
      await deleteChunkPrefix(env, params.capture.prefix, params.capture.chunks);
    }
  } catch (e) {
    console.warn("delete capture failed", e);
  }
}

// ---------------- 阶段:start(校验 / 领取 / 调上游 / 透传捕获) ----------------
async function handleStartPhase(env: Env, job: JobRow): Promise<void> {
  const params = parseParams(job.params);
  const preset = getSizePreset(String(params.size_preset || "a4"));
  const { w, h } = nativeSizeFor(preset);
  const requested = `${w}x${h}`;

  const { sources, editCtx, terminal } = await loadSources(env, job);
  if (terminal) return;

  const claimed = await run(
    env.DB,
    "UPDATE generation_jobs SET status = 'submitted', started_at = ? WHERE id = ? AND status = 'queued'",
    nowIso(), job.id,
  );
  if ((claimed.meta.changes ?? 0) !== 1) return;
  await setMessageMeta(env, job.message_id, { status: "submitted" });

  const rawPrefix = R2Keys.rawCapture(job.id);
  const authInit = (body: BodyInit, contentType?: string): RequestInit => ({
    method: "POST",
    headers: contentType
      ? { authorization: `Bearer ${env.AI_API_KEY}`, "content-type": contentType }
      : { authorization: `Bearer ${env.AI_API_KEY}` },
    body,
    signal: AbortSignal.timeout(180_000),
  });

  let capture;
  let requestId: string | null;
  try {
    const init = sources.length
      ? authInit(buildEditFormData({ model: job.model, prompt: job.prompt, requested, sources }))
      : authInit(JSON.stringify({ model: job.model, prompt: job.prompt, n: 1, size: requested, quality: "high" }), "application/json");
    const out = await startImageUpstream(env, {
      path: sources.length ? "/images/edits" : "/images/generations",
      init,
      rawPrefix,
    });
    capture = out.capture;
    requestId = out.requestId;
  } catch (e) {
    if (e instanceof ImageProviderError) {
      await markTerminal(env, job.id, e.uncertain ? "uncertain" : "failed", e.message);
    } else {
      await markTerminal(env, job.id, "failed", "生成过程异常,请稍后在版本列表确认");
    }
    return;
  }

  const nextParams: JobParams = {
    ...params,
    phase: "scan",
    capture,
    scan: newScanState(R2Keys.b64Chunks(job.id)),
    windows: { kind: "chunks", prefix: capture.prefix, total: capture.chunks, next: 0 },
    upstream: {
      requestId,
      upstreamSize: null, revisedPrompt: null, usage: null,
      source: "b64", sizeMismatch: false,
    },
    editCtx,
  };
  await casParams(env, job.id, job.params, nextParams);
  await enqueue(env, job.id);
}

// ---------------- 阶段:scan(每调用一个窗口,CAS 提交进度) ----------------
async function handleScanPhase(env: Env, job: JobRow, raw: string, params: JobParams): Promise<void> {
  const scan = params.scan!;
  const windows = params.windows!;
  const isLast = windows.next >= windows.total - 1;

  const obj = await env.MEDIA.get(`${windows.prefix}/${windows.next}`);
  if (!obj) {
    await markTerminal(env, job.id, "failed", "上游响应数据已丢失");
    return;
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());

  try {
    await scanWindow(env, scan, bytes, isLast);
  } catch (e) {
    await deleteCapture(env, params);
    await markTerminal(env, job.id, "failed", "响应解析失败,请重试");
    return;
  }

  windows.next += 1;
  if (windows.next < windows.total) {
    // CAS:重复消息同时扫同一窗口,只有一个能推进
    if (!(await casParams(env, job.id, raw, params))) return;
    await enqueue(env, job.id);
    return;
  }

  const fin = await finishScan(env, scan);
  const item = Array.isArray(fin.payload.data) ? fin.payload.data[0] ?? {} : {};
  const upstreamSize = typeof fin.payload.size === "string" ? fin.payload.size : null;
  const preset = getSizePreset(String(params.size_preset || "a4"));
  const { w, h } = nativeSizeFor(preset);
  const upstream: UpstreamMeta = {
    requestId: params.upstream?.requestId ?? null,
    upstreamSize,
    revisedPrompt: typeof item.revised_prompt === "string" ? item.revised_prompt : null,
    usage: fin.payload.usage && typeof fin.payload.usage === "object" ? fin.payload.usage : null,
    source: "b64",
    sizeMismatch: upstreamSize ? upstreamSize !== `${w}x${h}` : false,
  };

  // url 模式(最省 CPU):url 必须与图像 API 同源
  if (typeof item.url === "string" && fin.b64Chunks === 0) {
    const url = allowedImageUrl(env, item.url);
    if (!url) {
      await deleteCapture(env, params);
      await markTerminal(env, job.id, "failed", "图片下载地址不在允许范围内");
      return;
    }
    const decPrefix = R2Keys.decChunks(job.id);
    await deleteCapture(env, params);
    const nextParams: JobParams = {
      ...params, phase: "deliver", url,
      upstream: { ...upstream, source: "url" },
      dec: { prefix: decPrefix, chunks: 0, total: 0 },
      outKey: R2Keys.versionOriginal(job.project_id, crypto.randomUUID(), "png"),
      scan: undefined, capture: undefined, windows: undefined,
    };
    if (!(await casParams(env, job.id, raw, nextParams))) return;
    await enqueue(env, job.id);
    return;
  }

  if (fin.b64Chunks === 0) {
    await deleteCapture(env, params);
    await markTerminal(env, job.id, "failed", "模型未返回图片,请稍后重试或换一个模型");
    return;
  }

  upstream.source = "b64";
  // 小图:扫描完成这一次调用内直接解码(≤ B64_INLINE_LIMIT ≈ 数 ms CPU)
  if (fin.b64Bytes <= B64_INLINE_LIMIT) {
    const textChunks: string[] = [];
    for (let i = 0; i < fin.b64Chunks; i++) {
      const o = await env.MEDIA.get(`${scan.b64Prefix}/${i}`);
      if (!o) {
        await markTerminal(env, job.id, "failed", "图片数据已丢失");
        return;
      }
      textChunks.push(new TextDecoder().decode(await o.arrayBuffer()));
    }
    const bytes2 = decodeAsciiB64(textChunks.join(""));
    const sniff = sniffImageMime(bytes2.subarray(0, 16));
    if (!sniff) {
      await deleteCapture(env, params);
      await markTerminal(env, job.id, "failed", "上游返回的内容不是可识别的图片");
      return;
    }
    const dims = readImageDims(bytes2.subarray(0, 64));
    const outKey = R2Keys.versionOriginal(job.project_id, crypto.randomUUID(), sniff === "image/jpeg" ? "jpg" : "png");
    await env.MEDIA.put(outKey, bytes2.buffer.slice(bytes2.byteOffset, bytes2.byteOffset + bytes2.byteLength) as ArrayBuffer, {
      httpMetadata: { contentType: sniff },
    });
    // P0.3:persist 领取 —— 两个消费者只有一个能落库
    const claimedParams = await claimPhase(env, job.id, raw, { ...params, upstream, outKey, scan: undefined, capture: undefined, windows: undefined }, "persist");
    if (!claimedParams) return;
    await deleteCapture(env, params);
    await deleteChunkPrefix(env, scan.b64Prefix, fin.b64Chunks);
    await persistVersion(env, job, claimedParams, { key: outKey, mime: sniff, size: bytes2.byteLength, dims });
    return;
  }

  // 大图:进入 decode 阶段(raw 已抽取完毕 → 立即删除,防泄漏)
  await deleteCapture(env, params);
  const nextParams: JobParams = {
    ...params, phase: "decode", upstream,
    b64: { prefix: scan.b64Prefix, chunks: fin.b64Chunks, bytes: fin.b64Bytes, pad: fin.tailPadding },
    dec: { prefix: R2Keys.decChunks(job.id), chunks: 0, total: 0 },
    outKey: R2Keys.versionOriginal(job.project_id, crypto.randomUUID(), "png"),
    scan: undefined, capture: undefined, windows: undefined,
  };
  if (!(await casParams(env, job.id, raw, nextParams))) return;
  await run(env.DB, "UPDATE generation_jobs SET status = 'running' WHERE id = ? AND status NOT IN " + TERMINAL_STATES, job.id);
  await setMessageMeta(env, job.message_id, { status: "running" });
  await enqueue(env, job.id);
}

// ---------------- 阶段:deliver(url 模式,纯 I/O) ----------------
async function handleDeliverPhase(env: Env, job: JobRow, raw: string, params: JobParams): Promise<void> {
  try {
    const out = await captureUrlToChunks(env, params.url!, params.dec!.prefix);
    await assembleChunks(env, params.dec!.prefix, out.chunks, out.total, params.outKey!, out.mime);
    await deleteChunkPrefix(env, params.dec!.prefix, out.chunks);
    const head = await env.MEDIA.get(params.outKey!, { range: { offset: 0, length: 64 } });
    const dims = head ? readImageDims(new Uint8Array(await head.arrayBuffer())) : null;
    // P0.3:persist 领取
    const claimedParams = await claimPhase(env, job.id, raw, params, "persist");
    if (!claimedParams) return;
    await persistVersion(env, job, claimedParams, { key: params.outKey!, mime: out.mime, size: out.total, dims });
  } catch (e) {
    console.warn("deliver phase failed", job.id, e);
    if (e instanceof ImageProviderError && e.uncertain) {
      await markTerminal(env, job.id, "uncertain", e.message);
    } else if (e instanceof ImageProviderError) {
      await markTerminal(env, job.id, "failed", e.message);
    } else {
      await markTerminal(env, job.id, "failed", "图片下载交付失败,请稍后在版本列表确认");
    }
  }
}

// ---------------- 阶段:decode(逐分片 atob;最后一片合成) ----------------
async function handleDecodePhase(env: Env, job: JobRow, raw: string, params: JobParams): Promise<void> {
  const b64 = params.b64!;
  const dec = params.dec!;
  try {
    const idx = dec.chunks;
    if (idx >= b64.chunks) {
      // 进度已越界:说明有消息重复 —— 直接确认,由已推进的消费者继续
      return;
    }
    const obj = await env.MEDIA.get(`${b64.prefix}/${idx}`);
    if (!obj) throw new Error("图片数据已丢失");
    const text = new TextDecoder().decode(await obj.arrayBuffer());
    const bytes = decodeAsciiB64(text);
    // 解码分块写入是幂等的(同一 idx 同一字节),并发双写无害;CAS 裁决进度
    await env.MEDIA.put(`${dec.prefix}/${idx}`, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
    dec.chunks += 1;
    dec.total += bytes.byteLength;

    if (dec.chunks < b64.chunks) {
      if (!(await casParams(env, job.id, raw, params))) return;
      await enqueue(env, job.id);
      return;
    }

    // 最后一片:合成(纯 I/O)→ 清理 → persist 领取 → 落库
    await assembleChunks(env, dec.prefix, dec.chunks, dec.total, params.outKey!, "image/png");
    await deleteChunkPrefix(env, dec.prefix, dec.chunks);
    await deleteChunkPrefix(env, b64.prefix, b64.chunks);
    const head = await env.MEDIA.get(params.outKey!, { range: { offset: 0, length: 64 } });
    const dims = head ? readImageDims(new Uint8Array(await head.arrayBuffer())) : null;
    // 注意:保留 params.b64(persistVersion 依据它判定 deliver_mode = b64-staged)
    const claimedParams = await claimPhase(env, job.id, raw, params, "persist");
    if (!claimedParams) return;
    await persistVersion(env, job, claimedParams, { key: params.outKey!, mime: "image/png", size: dec.total, dims: dims ?? null });
  } catch (e) {
    // 上游已付费、数据已暂存 —— 不提示重试;CAS 记录错误后抛出交由巡检重驱动
    await run(env.DB, "UPDATE generation_jobs SET error = ? WHERE id = ? AND status NOT IN " + TERMINAL_STATES,
      `分块处理中断(${e instanceof Error ? e.message.slice(0, 120) : "unknown"}),结果已暂存,将在巡检中恢复`, job.id);
    throw e;
  }
}

export async function processJob(env: Env, jobId: string): Promise<void> {
  const job = await one<JobRow>(env.DB, "SELECT * FROM generation_jobs WHERE id = ?", jobId);
  if (!job) return;
  const raw = job.params;
  const params = parseParams(raw);

  if ((params.phase === "scan" || params.phase === "deliver") && (job.status === "submitted" || job.status === "running")) {
    if (params.phase === "scan") await handleScanPhase(env, job, raw, params);
    else await handleDeliverPhase(env, job, raw, params);
    return;
  }
  if (params.phase === "decode" && job.status === "running") {
    await handleDecodePhase(env, job, raw, params);
    return;
  }
  if (job.status !== "queued") return; // 重复投递/已终态

  if (job.model !== "gpt-image-2.6-flare" && job.model !== "gpt-image-2.6-sunburst") {
    await markTerminal(env, jobId, "failed", "所选模型不可用,请重新选择");
    return;
  }
  await handleStartPhase(env, job);
}

/** Queues 入口:批次内逐个处理;claim 保证不会二次调上游。 */
export async function handleQueueBatch(
  batch: MessageBatch<GenerationMessage>,
  env: Env,
): Promise<void> {
  for (const msg of batch.messages) {
    try {
      await processJob(env, msg.body.job_id);
      msg.ack();
    } catch (e) {
      console.error("job processing error", msg.body.job_id, e);
      const job = await one<{ status: string }>(env.DB, "SELECT status FROM generation_jobs WHERE id = ?", msg.body.job_id);
      // 仅领取前的失败值得重试;分阶段进度由 CAS + 巡检重驱动,绝不靠关闭重试掩盖问题
      if (job && job.status === "queued" && msg.attempts < 3) {
        msg.retry();
      } else {
        msg.ack();
      }
    }
  }
}
