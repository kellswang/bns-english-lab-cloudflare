/**
 * 费用核对 —— chat/billing.py 的 Cron 化(每 15 分钟一批)。
 * 原则原样保留:只有上游明确金额才 verified;查不到保持 pending;
 * 超过 2 小时仍 404 → unavailable;金额必须有限非负;退避 2 分钟。
 */
import type { Env } from "../types";
import { all, run, changes } from "../storage/db";
import { apiRoot, authHeaders } from "../chat/providers/base";

const COOLDOWN_SECONDS = 15;
const RETRY_INTERVAL_MS = 2 * 60 * 1000;

function parseAmount(payload: Record<string, unknown>): number | null {
  const amt = payload.amount;
  try {
    if (amt && typeof amt === "object") {
      const value = (amt as Record<string, unknown>).value;
      const currency = String((amt as Record<string, unknown>).currency || "USD").toUpperCase();
      if (currency !== "USD") return null;
      return Number(value);
    }
    if (amt !== undefined && amt !== null) return Number(amt);
  } catch {
    return null;
  }
  return null;
}

function validAmount(a: number | null): boolean {
  return a !== null && Number.isFinite(a) && a >= 0;
}

async function reconcileTable(env: Env, table: "chat_messages" | "summary_calls", limit: number): Promise<number> {
  const nowIso = new Date().toISOString();
  const candidates = await all<{ id: string; request_id: string; created_at: string; cost_checked_at: string | null }>(
    env.DB,
    `SELECT id, request_id, created_at, cost_checked_at FROM ${table} WHERE cost_status = 'pending' AND request_id IS NOT NULL ` +
    "ORDER BY cost_checked_at, created_at LIMIT ?",
    limit * 3,
  );
  const now = Date.now();
  let verified = 0;
  for (const row of candidates) {
    if (verified >= limit) break;
    const created = Date.parse(row.created_at);
    const checked = row.cost_checked_at ? Date.parse(row.cost_checked_at) : 0;
    if (now - created < COOLDOWN_SECONDS * 1000) continue;
    if (checked && now - checked < RETRY_INTERVAL_MS) continue;

    let amount: number | null = null;
    let status: number | null = null;
    try {
      const res = await fetch(`${apiRoot(env)}/v1/billing/requests/${row.request_id}`, {
        headers: authHeaders(env),
        signal: AbortSignal.timeout(20_000),
      });
      status = res.status;
      if (res.status === 200) {
        try { amount = parseAmount(await res.json() as Record<string, unknown>); } catch { amount = null; }
      }
    } catch {
      // 网络异常不当成免费,退避后重试
    }

    if (status === 200 && validAmount(amount)) {
      verified += await changes(
        env.DB,
        `UPDATE ${table} SET cost_usd = ?, cost_status = 'verified', cost_checked_at = ? WHERE id = ? AND cost_status = 'pending'`,
        amount, nowIso, row.id,
      );
    } else if (status === 404 && now - created > 2 * 3600 * 1000) {
      await changes(
        env.DB,
        `UPDATE ${table} SET cost_status = 'unavailable', cost_checked_at = ? WHERE id = ? AND cost_status = 'pending'`,
        nowIso, row.id,
      );
    } else {
      // 无论成败都推进 cost_checked_at:失败也有退避,不堵住后面的记录
      await run(env.DB, `UPDATE ${table} SET cost_checked_at = ? WHERE id = ? AND cost_status = 'pending'`, nowIso, row.id);
    }
  }
  return verified;
}

export async function reconcilePending(env: Env, limit = 8): Promise<number> {
  let verified = await reconcileTable(env, "chat_messages", limit);
  verified += await reconcileTable(env, "summary_calls", Math.max(2, Math.floor(limit / 2)));
  return verified;
}
