/**
 * 任务巡检与清理 —— 原 main.py sweep_loop / recover_jobs / 启动清理的 Cron 化。
 * - sweepQueued:DB 已提交但入队丢失的 queued 任务重投递(重复投递被原子领取挡住);
 * - recoverStuckJobs:submitted 超过 15 分钟无进展 → uncertain(不重调上游);
 * - cleanupExpired:过期验证码、旧限流计数、streaming 僵尸消息(6 小时)收敛。
 */
import type { Env } from "../types";
import { all, run } from "../storage/db";

const nowIso = () => new Date().toISOString();

export async function sweepQueued(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 30_000).toISOString();
  const rows = await all<{ id: string }>(
    env.DB,
    "SELECT id FROM generation_jobs WHERE status = 'queued' AND created_at <= ? LIMIT 50",
    cutoff,
  );
  for (const row of rows) {
    try {
      await env.GEN.send({ job_id: row.id });
    } catch (e) {
      console.error("sweep requeue failed", row.id, e);
    }
  }
  return rows.length;
}

export async function recoverStuckJobs(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  // submitted:已提交上游但消费者中断——结果未知,只能 uncertain
  const res1 = await run(
    env.DB,
    "UPDATE generation_jobs SET status = 'uncertain', error = ?, finished_at = ? WHERE status = 'submitted' AND started_at <= ?",
    "任务处理中断,结果待确认;不会自动重新调用付费接口,请按 request id 核对", nowIso(), cutoff,
  );
  // running:拿到响应但落库中断
  const res2 = await run(
    env.DB,
    "UPDATE generation_jobs SET status = 'interrupted', error = ?, finished_at = ? WHERE status = 'running' AND started_at <= ?",
    "服务中断了结果落库;不自动重调付费接口,请核对版本列表", nowIso(), cutoff,
  );
  return (res1.meta.changes ?? 0) + (res2.meta.changes ?? 0);
}

export async function cleanupExpired(env: Env): Promise<void> {
  const now = nowIso();
  await run(env.DB, "DELETE FROM email_login_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL AND created_at <= ?", now, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  await run(env.DB, "DELETE FROM rate_limit_counters WHERE CAST(window_start AS INTEGER) < ?", String(Date.now() - 26 * 3600 * 1000));
  // 断流僵尸:streaming 超过 6 小时视为 interrupted(Worker 实例回收后无进程内标记)
  await run(
    env.DB,
    "UPDATE chat_messages SET status = 'interrupted', error = COALESCE(error, '生成中断,内容可能不完整'), finished_at = COALESCE(finished_at, ?) WHERE status = 'streaming' AND created_at <= ?",
    now, new Date(Date.now() - 6 * 3600 * 1000).toISOString(),
  );
}
