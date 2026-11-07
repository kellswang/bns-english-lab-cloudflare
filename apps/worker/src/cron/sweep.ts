/**
 * 任务巡检与清理 —— P0.4 加固版:
 * - 每个阶段(params.phase)带 progressAt(CAS 时更新);
 * - 有 phase 的任务:进度停滞 > 10 分钟 → 重新投递(重复投递被 CAS 裁决,安全);
 *   进度停滞 > 2 小时 → 终态收敛(uncertain/interrupted,绝不重调付费接口);
 * - 无 phase 的 submitted/running:沿用原语义(started_at > 15 分钟);
 * - 队列消息丢失(queued 30 秒)→ 重投;
 * - 每日清理:过期验证码、限流计数、断流僵尸消息、R2 孤儿临时对象(48 小时)。
 */
import type { Env } from "../types";
import { all, one, run } from "../storage/db";
import { deleteStaleTmpObjects, statTmpObjects } from "../providers/imgpipe";

const nowIso = () => new Date().toISOString();
const PHASE_REDRIVE_MS = 10 * 60 * 1000;
const PHASE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const TMP_OBJECT_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const TMP_PREFIXES = ["tmp/raw/", "tmp/b64/", "tmp/dec/"];

export async function sweepQueued(env: Env): Promise<number> {
  let driven = 0;
  // ① queued 超时重投(入队丢失)
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const queued = await all<{ id: string }>(
    env.DB,
    "SELECT id FROM generation_jobs WHERE status = 'queued' AND created_at <= ? LIMIT 50",
    cutoff,
  );
  for (const row of queued) {
    try { await env.GEN.send({ job_id: row.id }); driven++; } catch (e) { console.error("sweep requeue failed", row.id, e); }
  }

  // ② 分阶段任务:按 progressAt 判断停滞(不是 started_at!)
  const phased = await all<{ id: string; params: string; created_at: string }>(
    env.DB,
    "SELECT id, params, created_at FROM generation_jobs WHERE status IN ('submitted','running') " +
    "AND params LIKE '%\"phase\"%' LIMIT 100",
  );
  const now = Date.now();
  for (const row of phased) {
    let params: Record<string, unknown> = {};
    try { params = JSON.parse(row.params || "{}"); } catch { continue; }
    const phase = params.phase as string | undefined;
    if (!phase || phase === "persist") continue;
    const progressAt = Date.parse(String(params.progressAt || row.created_at));
    if (Number.isNaN(progressAt)) continue;
    const age = now - progressAt;
    if (age < PHASE_REDRIVE_MS) continue;
    if (age > PHASE_MAX_AGE_MS) {
      // 长时间无法推进:收敛终态,交人工核对(上游已付费,不重调)
      const status = phase === "scan" && params.capture ? "uncertain" : "interrupted";
      await run(
        env.DB,
        "UPDATE generation_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ? AND status IN ('submitted','running')",
        status,
        status === "uncertain"
          ? "任务长时间停滞,结果待确认;不会自动重新调用付费接口,请按 request id 核对"
          : "任务长时间停滞,已中断;不自动重调付费接口,请核对版本列表",
        nowIso(), row.id,
      );
      continue;
    }
    try { await env.GEN.send({ job_id: row.id }); driven++; } catch (e) { console.error("sweep phase redrive failed", row.id, e); }
  }
  return driven;
}

export async function recoverStuckJobs(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  // 仅覆盖无 phase 的任务(上游已提交但捕获未落库 / 落库中断)
  const res1 = await run(
    env.DB,
    "UPDATE generation_jobs SET status = 'uncertain', error = ?, finished_at = ? " +
    "WHERE status = 'submitted' AND started_at <= ? AND params NOT LIKE '%\"phase\"%'",
    "任务处理中断,结果待确认;不会自动重新调用付费接口,请按 request id 核对", nowIso(), cutoff,
  );
  const res2 = await run(
    env.DB,
    "UPDATE generation_jobs SET status = 'interrupted', error = ?, finished_at = ? " +
    "WHERE status = 'running' AND started_at <= ? AND params NOT LIKE '%\"phase\"%'",
    "服务中断了结果落库;不自动重调付费接口,请核对版本列表", nowIso(), cutoff,
  );
  return (res1.meta.changes ?? 0) + (res2.meta.changes ?? 0);
}

export async function cleanupExpired(env: Env): Promise<void> {
  const now = nowIso();
  await run(env.DB, "DELETE FROM email_login_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL AND created_at <= ?", now, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  await run(env.DB, "DELETE FROM rate_limit_counters WHERE CAST(window_start AS INTEGER) < ?", String(Date.now() - 26 * 3600 * 1000));
  await run(
    env.DB,
    "UPDATE chat_messages SET status = 'interrupted', error = COALESCE(error, '生成中断,内容可能不完整'), finished_at = COALESCE(finished_at, ?) WHERE status = 'streaming' AND created_at <= ?",
    now, new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
  );
  // P0.5:R2 孤儿临时对象(48h 前的 tmp 分块)—— 幂等,失败不影响主流程
  try {
    const deleted = await deleteStaleTmpObjects(env, TMP_PREFIXES, TMP_OBJECT_MAX_AGE_MS);
    if (deleted) {
      const stat = await statTmpObjects(env, TMP_PREFIXES);
      console.log(`tmp cleanup: deleted ${deleted}, remaining ${stat.count} objects / ${stat.bytes} bytes`);
    }
  } catch (e) {
    console.error("tmp cleanup failed", e);
  }
}
