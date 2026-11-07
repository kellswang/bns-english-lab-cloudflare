/**
 * /models、/uploads、/generate、/jobs/:id —— 对应原 backend/app/api/generation.py。
 * 幂等语义原样保留:(user_id, client_request_id) 唯一约束 + request_hash
 * 区分「同键不同参数」→ 409;并发同键靠 D1 唯一索引兜底。
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { loadConfig } from "../config";
import { getOptionalUser, requireActive, getOwnedProject, audit, type AppCtx } from "../auth/deps";
import { HttpError, json, naiveUtc } from "../utils/http";
import { one, run } from "../storage/db";
import { IMAGE_MODELS, getImageModel, getSizePreset, nativeSizeFor, sizePresetsPublic, DEFAULT_SIZE_PRESET } from "../domain/images";
import { R2Keys, putObject, sniffImageMime } from "../storage/r2";

export const generationRoutes = new Hono<{ Bindings: Env }>();

const nowIso = () => new Date().toISOString();

generationRoutes.get("/models", async (c) => {
  const ctx = await getOptionalUser(c);
  requireActive(ctx);
  return json({
    items: IMAGE_MODELS,
    default: IMAGE_MODELS[0]?.id ?? "",
    size_presets: sizePresetsPublic(),
    default_size: DEFAULT_SIZE_PRESET,
    quality: "2K",
    output_long_edge: 2048,
  });
});

/** 参考图上传:魔数校验 + 大小上限;EXIF 清除由浏览器端完成(见闸门 A/D),服务端不信任声明 MIME。 */
generationRoutes.post("/uploads", async (c) => {
  const ctx = await getOptionalUser(c);
  const user = requireActive(ctx);
  const cfg = loadConfig(c.env);
  const form = await c.req.parseBody();
  const projectId = String(form.project_id || "");
  const file = form.file;
  if (!(file instanceof File)) throw new HttpError(400, "缺少文件");
  await getOwnedProject(ctx, projectId, { write: true });

  const raw = await file.arrayBuffer();
  if (raw.byteLength === 0) throw new HttpError(400, "文件为空");
  if (raw.byteLength > cfg.maxUploadBytes) throw new HttpError(413, "参考图不能超过 12 MB");
  const mime = sniffImageMime(new Uint8Array(raw.slice(0, 16)));
  if (!mime) throw new HttpError(400, "只支持 PNG / JPEG / WebP 图片");

  const uploadId = crypto.randomUUID();
  const key = R2Keys.upload(projectId, uploadId, mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png");
  await putObject(c.env, key, raw, mime, { length: raw.byteLength });
  await run(
    c.env.DB,
    "INSERT INTO uploads (id, project_id, owner_id, filename, content_type, size_bytes, rel_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    uploadId, projectId, user.id, (file.name || "ref.png").slice(0, 255), mime, raw.byteLength, key, nowIso(),
  );
  await audit(ctx, "upload_reference", { entityId: uploadId, detail: (file.name || "").slice(0, 200) });
  return json({ id: uploadId, url: `/api/v1/uploads/${uploadId}/image`, filename: (file.name || "ref.png").slice(0, 255) }, 201);
});

interface GenerateBody {
  project_id: string;
  prompt: string;
  model: string;
  source_version_id?: string | null;
  reference_ids?: string[];
  size?: string;
  quality?: string;
  discard_source?: boolean;
  client_request_id?: string | null;
}

function replay(job: { id: string; message_id: string | null; status: string; version_id: string | null }) {
  return {
    job_id: job.id,
    message_id: job.message_id,
    status: job.status,
    version_id: job.version_id,
    deduplicated: true,
  };
}

async function findbyClientRequest(
  db: D1Database, userId: string, clientId: string, requestHash: string,
) {
  const job = await one<{ id: string; message_id: string | null; status: string; version_id: string | null; request_hash: string | null }>(
    db,
    "SELECT id, message_id, status, version_id, request_hash FROM generation_jobs WHERE user_id = ? AND client_request_id = ?",
    userId, clientId,
  );
  if (!job) return null;
  if (job.request_hash && job.request_hash !== requestHash) {
    throw new HttpError(409, {
      reason: "idempotency_key_reused",
      message: "这个请求标识已经用于另一组参数,请重新发起生成。",
    });
  }
  return job;
}

async function checkCapacity(ctx: AppCtx): Promise<void> {
  const db = ctx.env.DB;
  const cfg = loadConfig(ctx.env);
  const mine = await one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM generation_jobs WHERE user_id = ? AND status IN ('queued','submitted','running')", ctx.user!.id);
  if ((mine?.n ?? 0) >= cfg.imageMaxActivePerUser) {
    throw new HttpError(429, {
      reason: "too_many_active_jobs",
      message: `你还有 ${mine?.n ?? 0} 个生成任务在进行中,等其中一张出图后再继续。`,
    });
  }
  const total = await one<{ n: number }>(
    db, "SELECT COUNT(*) AS n FROM generation_jobs WHERE status IN ('queued','submitted','running')");
  if ((total?.n ?? 0) >= cfg.imageMaxActiveGlobal) {
    throw new HttpError(503, { reason: "queue_full", message: "当前生成队列已满,请稍等一两分钟再试。" });
  }
  const limit = cfg.imageDailyLimitPerUser;
  if (limit > 0) {
    // 按北京时间自然日计
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const key = `image:day:${ctx.user!.id}:${day}`;
    const row = await one<{ hits: number }>(
      db,
      "INSERT INTO rate_limit_counters (key, window_start, hits, updated_at) VALUES (?, ?, 1, ?) " +
      "ON CONFLICT(key) DO UPDATE SET hits = hits + 1, updated_at = excluded.updated_at RETURNING hits",
      key, String(Date.now()), nowIso(),
    );
    const used = row ? Number(row.hits) : 1;
    if (used > limit) {
      await run(db, "UPDATE rate_limit_counters SET hits = MAX(hits - 1, 0) WHERE key = ?", key);
      throw new HttpError(429, {
        reason: "daily_limit",
        message: `今天的生成额度已用完(${limit} 张/天),明天会重置。`,
      });
    }
  }
}

generationRoutes.post("/generate", async (c) => {
  const ctx = await getOptionalUser(c);
  const user = requireActive(ctx);
  const body = await c.req.json<GenerateBody>().catch(() => null);
  if (!body) throw new HttpError(422, "请求体不合法");
  const project = await getOwnedProject(ctx, body.project_id || "", { write: true });

  const prompt = (body.prompt || "").trim();
  if (!prompt || prompt.length > 8000) throw new HttpError(422, "请输入 1-8000 字的描述");
  const spec = getImageModel(body.model || "");
  if (!spec) throw new HttpError(400, "请选择可用的模型");

  // ---------- 修改意图硬校验 ----------
  let source: { id: string; version_no: number; rel_path: string; project_id: string } | null = null;
  if (body.source_version_id) {
    if (!spec.supports_edit) {
      throw new HttpError(409, {
        reason: "model_no_edit",
        message: `${spec.label} 不支持基于原图修改。请换用支持编辑的模型,或明确选择「放弃原图,重新生成一张」。`,
      });
    }
    source = await one<{ id: string; version_no: number; rel_path: string; project_id: string }>(
      c.env.DB, "SELECT id, version_no, rel_path, project_id FROM versions WHERE id = ?", body.source_version_id);
    if (!source || source.project_id !== project.id) {
      throw new HttpError(404, "所选图片版本不存在,请重新选择");
    }
    if (!(await c.env.MEDIA.head(source.rel_path))) {
      throw new HttpError(410, "所选版本的源图文件已丢失,请改用其他版本");
    }
  }

  const refs: string[] = [];
  for (const refId of (body.reference_ids || []).slice(0, 4)) {
    const up = await one<{ id: string; project_id: string; rel_path: string }>(
      c.env.DB, "SELECT id, project_id, rel_path FROM uploads WHERE id = ?", refId);
    if (!up || up.project_id !== project.id) throw new HttpError(404, "参考图不存在或不属于该项目");
    if (!(await c.env.MEDIA.head(up.rel_path))) throw new HttpError(410, "参考图文件已丢失,请重新上传");
    refs.push(refId);
  }

  const preset = getSizePreset(body.size || DEFAULT_SIZE_PRESET);
  const { w, h } = nativeSizeFor(preset);

  // ---------- 幂等 ----------
  const fingerprint = JSON.stringify({
    prompt, model: body.model, size: preset.id,
    source: source?.id ?? null, refs, discard: Boolean(body.discard_source),
  });
  const requestHash = await sha256Hex(fingerprint);
  const clientId = (body.client_request_id || "").trim() || null;

  if (clientId) {
    const existing = await findbyClientRequest(c.env.DB, user.id, clientId, requestHash);
    if (existing) return json(replay(existing), 202);
  }

  await checkCapacity(ctx);

  const sizeMeta = {
    size_preset: preset.id,
    size_label: preset.label,
    native_size: `${w}x${h}`,
    quality: "2k",
    output_long_edge: 2048,
    fingerprint,
  };
  const mode = source || refs.length ? "edit" : "generate";
  const meta = {
    model: body.model, model_label: spec.label, mode,
    source_version_id: source?.id ?? null,
    source_version_no: source?.version_no ?? null,
    discard_source: Boolean(body.discard_source) && !source,
    reference_ids: refs,
    ...sizeMeta,
    status: "queued",
  };

  const messageId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO messages (id, project_id, author_id, role, content, kind, attachments, meta, created_at) VALUES (?, ?, ?, 'user', ?, 'generation', ?, ?, ?)",
      ).bind(messageId, project.id, user.id, prompt, JSON.stringify(refs), JSON.stringify(meta), nowIso()),
      c.env.DB.prepare(
        "INSERT INTO generation_jobs (id, project_id, user_id, message_id, status, model, prompt, mode, source_version_id, reference_ids, params, client_request_id, request_hash, created_at) " +
        "VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(jobId, project.id, user.id, messageId, body.model, prompt, mode,
        source?.id ?? null, JSON.stringify(refs), JSON.stringify(sizeMeta),
        clientId, clientId ? requestHash : null, nowIso()),
      c.env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(nowIso(), project.id),
    ]);
  } catch {
    // 并发同键:唯一索引兜底,回查返回那一条
    if (clientId) {
      const existing = await findbyClientRequest(c.env.DB, user.id, clientId, requestHash);
      if (existing) return json(replay(existing), 202);
    }
    throw new HttpError(409, "同一次请求正在处理中,请稍后查看结果");
  }

  await audit(ctx, "generate", { entityId: jobId, detail: `model=${body.model} mode=${mode} source=${source?.id ?? "-"}` });

  // D1 已提交;入队失败由巡检 Cron 补偿(sweep 重投 queued 任务)
  await c.env.GEN.send({ job_id: jobId });

  return json({ job_id: jobId, message_id: messageId, status: "queued", version_id: null, deduplicated: false }, 202);
});

generationRoutes.get("/jobs/:jobId", async (c) => {
  const ctx = await getOptionalUser(c);
  requireActive(ctx);
  const job = await one<{ id: string; status: string; error: string | null; version_id: string | null; model: string; mode: string; created_at: string; project_id: string }>(
    c.env.DB, "SELECT * FROM generation_jobs WHERE id = ?", c.req.param("jobId"));
  if (!job) throw new HttpError(404, "任务不存在");
  await getOwnedProject(ctx, job.project_id);
  let version_no: number | undefined;
  if (job.version_id) {
    const v = await one<{ version_no: number }>(c.env.DB, "SELECT version_no FROM versions WHERE id = ?", job.version_id);
    if (v) version_no = v.version_no;
  }
  return json({
    id: job.id, status: job.status, error: job.error,
    version_id: job.version_id, model: job.model, mode: job.mode,
    created_at: naiveUtc(job.created_at),
    ...(version_no !== undefined ? { version_no } : {}),
  });
});

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
