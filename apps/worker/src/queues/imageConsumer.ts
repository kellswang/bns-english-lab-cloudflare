/**
 * 图片生成任务消费者 —— worker.py 状态机的 Queues 翻译。
 *
 * 状态语义(对用户可见,原样保留):
 *   queued / submitted / running / succeeded / failed / uncertain / interrupted / pending_save
 *
 * 核心规则:
 * 1. 原子领取:UPDATE ... WHERE status='queued' 只有 changes=1 的那次能调上游;
 *    队列至少一次投递 + 重复消息只会跳过,绝不二次付费。
 * 2. 上游超时/断连/5xx → uncertain,绝不自动重试付费请求。
 * 3. 落库顺序:先 R2 写对象(键含 versionId UUID,与版本号无关),再 D1 事务
 *    (version_seq 原子取号 + 版本行 + job 终态 + message meta);D1 失败时
 *    R2 对象成为孤儿,由每日清理 Cron 回收(键路径可由 job.params 定位)。
 * 4. pending_save:上游已出图但 D1 提交失败——保留字节线索,不提示重试。
 */
import type { Env, GenerationMessage } from "../types";
import { one, run, changes } from "../storage/db";
import { R2Keys, putObject } from "../storage/r2";
import { editImage, generateImage, ImageProviderError } from "../providers/imageGateway";
import { getSizePreset, nativeSizeFor } from "../domain/images";
import { loadConfig } from "../config";

const nowIso = () => new Date().toISOString();

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

async function setMessageMeta(env: Env, messageId: string | null, fields: Record<string, unknown>): Promise<void> {
  if (!messageId) return;
  const row = await one<{ meta: string }>(env.DB, "SELECT meta FROM messages WHERE id = ?", messageId);
  if (!row) return;
  const meta = { ...JSON.parse(row.meta || "{}"), ...fields };
  await run(env.DB, "UPDATE messages SET meta = ? WHERE id = ?", JSON.stringify(meta), messageId);
}

async function markTerminal(
  env: Env, jobId: string, status: string, message: string, versionId: string | null = null,
): Promise<void> {
  const job = await one<JobRow>(env.DB, "SELECT * FROM generation_jobs WHERE id = ?", jobId);
  if (!job) return;
  await run(
    env.DB,
    "UPDATE generation_jobs SET status = ?, error = ?, finished_at = ?, version_id = COALESCE(?, version_id) WHERE id = ?",
    status, message.slice(0, 600), nowIso(), versionId, jobId,
  );
  await setMessageMeta(env, job.message_id, { status, error: message.slice(0, 300) });
  await run(
    env.DB,
    "INSERT INTO audit_logs (id, actor_email, action, entity_id, detail, ip, created_at) VALUES (?, NULL, ?, ?, ?, NULL, ?)",
    crypto.randomUUID(), `generation_${status}`, jobId, message.slice(0, 200), nowIso(),
  );
}

/** 原子领取:只有把 queued 改成 submitted 的这一次可以调上游。 */
async function claimJob(env: Env, jobId: string): Promise<boolean> {
  const changed = await changes(
    env.DB,
    "UPDATE generation_jobs SET status = 'submitted', started_at = ? WHERE id = ? AND status = 'queued'",
    nowIso(), jobId,
  );
  return changed === 1;
}

export async function processJob(env: Env, jobId: string): Promise<void> {
  const cfg = loadConfig(env);
  const job = await one<JobRow>(env.DB, "SELECT * FROM generation_jobs WHERE id = ?", jobId);
  if (!job || job.status !== "queued") return; // 重复投递/已终态:直接确认

  // ---------- 校验阶段(仍为 queued,失败可安全终态,未付费) ----------
  if (job.model !== "gpt-image-2.6-flare" && job.model !== "gpt-image-2.6-sunburst") {
    await markTerminal(env, jobId, "failed", "所选模型不可用,请重新选择");
    return;
  }

  const params = JSON.parse(job.params || "{}") as Record<string, unknown>;
  const preset = getSizePreset(String(params.size_preset || "a4"));
  const { w, h } = nativeSizeFor(preset);

  const sources: Array<{ filename: string; mime: string; data: ArrayBuffer }> = [];
  let parent: { id: string; version_no: number; branch_name: string } | null = null;

  if (job.source_version_id) {
    const src = await one<{ id: string; version_no: number; branch_name: string; rel_path: string; project_id: string }>(
      env.DB, "SELECT id, version_no, branch_name, rel_path, project_id FROM versions WHERE id = ?", job.source_version_id);
    if (!src || src.project_id !== job.project_id) {
      await markTerminal(env, jobId, "failed", "引用的图片版本不存在,请重新选择");
      return;
    }
    const obj = await env.MEDIA.get(src.rel_path);
    if (!obj) {
      await markTerminal(env, jobId, "failed", "引用的源图文件已丢失,请重新生成");
      return;
    }
    sources.push({ filename: `v${src.version_no}.png`, mime: "image/png", data: await obj.arrayBuffer() });
    parent = { id: src.id, version_no: src.version_no, branch_name: src.branch_name };
  }

  for (const refId of JSON.parse(job.reference_ids || "[]") as string[]) {
    const up = await one<{ id: string; filename: string; content_type: string; rel_path: string; project_id: string }>(
      env.DB, "SELECT id, filename, content_type, rel_path, project_id FROM uploads WHERE id = ?", refId);
    if (!up || up.project_id !== job.project_id) continue;
    const obj = await env.MEDIA.get(up.rel_path);
    if (obj) sources.push({ filename: up.filename || "ref.png", mime: up.content_type || "image/png", data: await obj.arrayBuffer() });
  }

  // ---------- 原子领取 ----------
  if (!(await claimJob(env, jobId))) return;
  await setMessageMeta(env, job.message_id, { status: "submitted" });

  // ---------- 上游调用(一次,失败按 uncertain/failed 收敛) ----------
  let result;
  try {
    result = sources.length
      ? await editImage(env, { model: job.model, prompt: job.prompt, width: w, height: h, sources })
      : await generateImage(env, { model: job.model, prompt: job.prompt, width: w, height: h });
  } catch (e) {
    if (e instanceof ImageProviderError) {
      await markTerminal(env, jobId, e.uncertain ? "uncertain" : "failed", e.message);
    } else {
      await markTerminal(env, jobId, "failed", "生成过程异常,请稍后在版本列表确认");
    }
    return;
  }

  // ---------- 已拿到结果:先落 request_id(对账线索) ----------
  await run(
    env.DB,
    "UPDATE generation_jobs SET status = 'running', params = ? WHERE id = ?",
    JSON.stringify({ ...params, upstream_request_id: result.requestId, upstream_size: result.upstreamSize, submitted_at: nowIso() }),
    jobId,
  );

  // ---------- R2 写原图 ----------
  const versionId = crypto.randomUUID();
  const ext = result.mime === "image/jpeg" ? "jpg" : "png";
  const relPath = R2Keys.versionOriginal(job.project_id, versionId, ext);
  try {
    await env.MEDIA.put(relPath, result.data, {
      httpMetadata: { contentType: result.mime },
    });
  } catch {
    // R2 写失败:上游已扣费,标 pending_save,绝不提示重试
    await markTerminal(env, jobId, "pending_save", "图片已返回但本地保存失败,请稍后在版本列表确认");
    return;
  }

  // ---------- D1 事务:原子取版本号 → 版本行 → job 终态 → message meta ----------
  try {
    const seqRow = await one<{ version_seq: number }>(
      env.DB,
      "UPDATE projects SET version_seq = version_seq + 1, updated_at = ? WHERE id = ? RETURNING version_seq",
      nowIso(), job.project_id,
    );
    if (!seqRow) throw new Error("项目不存在");
    let versionNo = seqRow.version_seq;

    const versionParams = {
      ...params,
      unit_price_usd: cfg.pricePerImageUsd,
      reference_count: sources.length,
      size_label: preset.label,
      size_preset: preset.id,
      requested_native_px: `${w}×${h}`,
      model_native_px: result.upstreamSize,
      output_px: result.upstreamSize || requestedFallback(result),
      native_2k: !result.sizeMismatch,
      size_mismatch: result.sizeMismatch,
      was_resized: false,
      was_cropped: false,
      upstream_size: result.upstreamSize,
      upstream_request_id: result.requestId,
      upstream_quality: "high",
      upstream_usage: result.usage,
      upstream_source: result.source,
    };

    const branchName = parent ? await nextBranchName(env, job.project_id, parent) : "MAIN";
    // 像素尺寸取上游声明(无 Pillow 无法自行解码);缺失则如实为 NULL
    const dims = result.upstreamSize?.match(/^(\d+)x(\d+)$/);
    const width = dims ? Number(dims[1]) : null;
    const height = dims ? Number(dims[2]) : null;
    let inserted = false;
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO versions (id, project_id, message_id, parent_id, source_version_id, version_no, branch_name, mode, model, prompt, revised_prompt, params, rel_path, thumb_path, width, height, mime, size_bytes, is_starred, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 0, ?)",
          ).bind(
            versionId, job.project_id, job.message_id, parent?.id ?? null, job.source_version_id,
            versionNo, branchName, sources.length ? "edit" : "generate", job.model, job.prompt,
            result.revisedPrompt, JSON.stringify(versionParams), relPath,
            width, height, result.mime, result.data.byteLength, nowIso(),
          ),
          env.DB.prepare(
            "UPDATE generation_jobs SET status = 'succeeded', version_id = ?, finished_at = ? WHERE id = ? AND status = 'running'",
          ).bind(versionId, nowIso(), jobId),
        ]);
        inserted = true;
      } catch {
        // (project_id, version_no) 唯一冲突:重取号重试,不重调上游,不换 R2 键
        const retry = await one<{ version_seq: number }>(
          env.DB,
          "UPDATE projects SET version_seq = version_seq + 1 WHERE id = ? RETURNING version_seq",
          job.project_id,
        );
        if (!retry) throw new Error("版本号分配失败");
        versionNo = retry.version_seq;
      }
    }
    if (!inserted) throw new Error("版本号分配重试仍失败");

    const version = await one<{ version_no: number }>(env.DB, "SELECT version_no FROM versions WHERE id = ?", versionId);
    await setMessageMeta(env, job.message_id, {
      version_id: versionId,
      version_no: version?.version_no ?? versionNo,
      model: job.model,
      mode: sources.length ? "edit" : "generate",
      status: "succeeded",
    });
  } catch (e) {
    // D1 提交失败:R2 已有原图,等人工/巡检恢复 —— pending_save
    await markTerminal(
      env, jobId, "pending_save",
      `图片已返回但本地保存失败(${e instanceof Error ? e.name : "unknown"}),请稍后在版本列表确认`,
    );
  }
}

function requestedFallback(result: { requestedSize: string }): string {
  const [w, h] = result.requestedSize.split("x");
  return `${w}×${h}`;
}

/** 分支命名:第一个子版本沿用父分支,后续兄弟分支 B1、B2…(与原 _branch_name 一致)。 */
async function nextBranchName(
  env: Env, projectId: string, parent: { id: string; branch_name: string },
): Promise<string> {
  const siblings = await one<{ n: number }>(
    env.DB, "SELECT COUNT(*) AS n FROM versions WHERE parent_id = ?", parent.id);
  if ((siblings?.n ?? 0) === 0) return parent.branch_name;
  const used = await one<{ n: number }>(
    env.DB,
    "SELECT COUNT(DISTINCT branch_name) AS n FROM versions WHERE project_id = ? AND branch_name LIKE 'B%'",
    projectId,
  );
  return `B${(used?.n ?? 0) + 1}`;
}

/** Queues 入口:批次内逐个处理;任何异常抛出会触发重试,但 claim 保证不会二次调上游。 */
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
      // 若任务仍在 queued(领取前异常),重试有意义;submitted 之后 claim 已挡住二次调用
      const job = await one<{ status: string }>(env.DB, "SELECT status FROM generation_jobs WHERE id = ?", msg.body.job_id);
      if (job && job.status === "queued" && msg.attempts < 3) {
        msg.retry();
      } else {
        msg.ack();
      }
    }
  }
}
