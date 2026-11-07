/**
 * 用量与管理页 —— 对应原 api/usage.py 与 api/admin.py 的统计口径:
 * 图片 = 版本数 × 快照单价(缺快照用当前价);对话 = verified 金额,pending 只计数;
 * 管理页只读,时间输出北京时间 ISO。
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { loadConfig } from "../config";
import { getOptionalUser, requireUser, requireAdmin } from "../auth/deps";
import { HttpError, json } from "../utils/http";
import { all, one } from "../storage/db";

export const usageRoutes = new Hono<{ Bindings: Env }>();
export const adminRoutes = new Hono<{ Bindings: Env }>();

/** 北京时间 ISO(与原 bjt_iso 一致:+08:00 后缀) */
function bjtIso(naiveUtcStr: string | null): string | null {
  if (!naiveUtcStr) return null;
  return naiveUtcStr + "+08:00";
}

usageRoutes.get("/usage", async (c) => {
  const ctx = await getOptionalUser(c);
  const u = requireUser(ctx);
  const cfg = loadConfig(c.env);
  const row = await one<{ images: number; snap: number | null; no_snap: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS images, " +
    "COALESCE(SUM(CAST(json_extract(v.params, '$.unit_price_usd') AS REAL)), 0) AS snap, " +
    "SUM(CASE WHEN json_extract(v.params, '$.unit_price_usd') IS NULL THEN 1 ELSE 0 END) AS no_snap " +
    "FROM versions v JOIN projects p ON v.project_id = p.id WHERE p.owner_id = ?",
    u.id,
  );
  const images = row?.images ?? 0;
  const snap = row?.snap ?? 0;
  const noSnap = row?.no_snap ?? 0;
  const amount = Math.round((snap + noSnap * cfg.pricePerImageUsd) * 10000) / 10000;

  const chat = await one<{ verified: number | null; pending: number }>(
    c.env.DB,
    "SELECT " +
    "(SELECT COALESCE(SUM(cost_usd),0) FROM chat_messages WHERE owner_id = ?1 AND cost_status = 'verified') + " +
    "(SELECT COALESCE(SUM(cost_usd),0) FROM summary_calls WHERE owner_id = ?1 AND cost_status = 'verified') AS verified, " +
    "(SELECT COUNT(*) FROM chat_messages WHERE owner_id = ?1 AND cost_status = 'pending' AND request_id IS NOT NULL) + " +
    "(SELECT COUNT(*) FROM summary_calls WHERE owner_id = ?1 AND cost_status = 'pending' AND request_id IS NOT NULL) AS pending",
    u.id,
  );
  const chatAmount = Math.round((chat?.verified ?? 0) * 1e6) / 1e6;
  return json({
    images,
    amount_usd: amount,
    chat_amount_usd: chatAmount,
    chat_pending: chat?.pending ?? 0,
    total_usd: Math.round((amount + chatAmount) * 10000) / 10000,
    unit_price_usd: cfg.pricePerImageUsd,
    currency: "USD",
    scope: "mine",
    basis: "flat_rate_estimate",
    note: "图片按站内固定单价估算,对话费用以后台上游账单核对结果为准",
  });
});

adminRoutes.get("/admin/overview", async (c) => {
  const ctx = await getOptionalUser(c);
  requireAdmin(ctx);
  const cfg = loadConfig(c.env);
  const users = await all<Record<string, string | number | null>>(
    c.env.DB,
    "SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_login_at, " +
    "COALESCE(img.images, 0) AS images, " +
    "COALESCE(img.snap, 0) AS img_snap, COALESCE(img.no_snap, 0) AS img_no_snap, " +
    "COALESCE(chat.verified, 0) AS chat_verified, COALESCE(chat.pending, 0) AS chat_pending " +
    "FROM users u " +
    "LEFT JOIN (SELECT p.owner_id, COUNT(v.id) AS images, " +
    "  SUM(CAST(json_extract(v.params, '$.unit_price_usd') AS REAL)) AS snap, " +
    "  SUM(CASE WHEN json_extract(v.params, '$.unit_price_usd') IS NULL THEN 1 ELSE 0 END) AS no_snap " +
    "  FROM versions v JOIN projects p ON v.project_id = p.id GROUP BY p.owner_id) img ON img.owner_id = u.id " +
    "LEFT JOIN (SELECT owner_id, " +
    "  SUM(CASE WHEN cost_status = 'verified' THEN COALESCE(cost_usd, 0) ELSE 0 END) AS verified, " +
    "  SUM(CASE WHEN cost_status = 'pending' AND request_id IS NOT NULL THEN 1 ELSE 0 END) AS pending " +
    "  FROM (SELECT owner_id, cost_status, request_id, cost_usd FROM chat_messages " +
    "        UNION ALL SELECT owner_id, cost_status, request_id, cost_usd FROM summary_calls) " +
    "  GROUP BY owner_id) chat ON chat.owner_id = u.id " +
    "ORDER BY u.created_at",
  );
  const items = users.map((u) => {
    const images = Number(u.images);
    const imageAmount = Math.round((Number(u.img_snap) + Number(u.img_no_snap) * cfg.pricePerImageUsd) * 10000) / 10000;
    const chatAmount = Math.round(Number(u.chat_verified) * 1e6) / 1e6;
    return {
      id: u.id, email: u.email, display_name: u.display_name, role: u.role, status: u.status,
      created_at: bjtIso(String(u.created_at)),
      last_login_at: bjtIso(u.last_login_at ? String(u.last_login_at) : null),
      images,
      image_amount_usd: imageAmount,
      chat_amount_usd: chatAmount,
      chat_pending: Number(u.chat_pending),
      total_usd: Math.round((imageAmount + chatAmount) * 10000) / 10000,
    };
  });
  const totals = {
    users: items.length,
    images: items.reduce((s, i) => s + i.images, 0),
    image_amount_usd: Math.round(items.reduce((s, i) => s + i.image_amount_usd, 0) * 10000) / 10000,
    chat_amount_usd: Math.round(items.reduce((s, i) => s + i.chat_amount_usd, 0) * 1e6) / 1e6,
    chat_pending: items.reduce((s, i) => s + i.chat_pending, 0),
    total_usd: Math.round(items.reduce((s, i) => s + i.total_usd, 0) * 10000) / 10000,
  };
  return json({
    users: items,
    totals,
    unit_price_usd: cfg.pricePerImageUsd,
    currency: "USD",
    basis: "flat_rate_estimate",
    note: "图片按生成时快照单价估算;对话费用只计已核对金额,待核算仅显示条数",
  });
});

adminRoutes.get("/admin/logs", async (c) => {
  const ctx = await getOptionalUser(c);
  requireAdmin(ctx);
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") || 100)));
  const offset = Math.max(0, Number(c.req.query("offset") || 0));
  const email = (c.req.query("email") || "").trim().toLowerCase().slice(0, 160);
  const action = (c.req.query("action") || "").trim().slice(0, 64);

  const conds: string[] = [];
  const params: unknown[] = [];
  if (email) { conds.push("a.actor_email = ?"); params.push(email); }
  if (action) { conds.push("a.action = ?"); params.push(action); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

  const rows = await all<Record<string, string | null>>(
    c.env.DB,
    `SELECT a.id, a.actor_email, u.display_name AS actor_name, a.action, a.entity_id, a.detail, a.ip, a.created_at
     FROM audit_logs a LEFT JOIN users u ON u.email = a.actor_email
     ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    ...params, limit, offset,
  );
  const totalRow = await one<{ n: number }>(
    c.env.DB, `SELECT COUNT(*) AS n FROM audit_logs a ${where}`, ...params);
  const actions = (await all<{ action: string }>(c.env.DB, "SELECT DISTINCT action FROM audit_logs ORDER BY action"))
    .map((r) => r.action);
  return json({
    items: rows.map((r) => ({ ...r, created_at: bjtIso(r.created_at ?? null) })),
    total: totalRow?.n ?? 0,
    limit,
    offset,
    actions,
  });
});
