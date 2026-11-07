/**
 * 认证中间件与项目归属 —— 对应原 backend/app/api/deps.py。
 * 权限语义保持一致:仅 owner;越权与不存在统一 404;停用立即 403。
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { decodeSessionToken } from "../auth/tokens";
import { loadConfig, type GradeConfig } from "../config";
import type { Env } from "../types";
import { HttpError, clientIp } from "../utils/http";
import { one, nowIso, run } from "../storage/db";

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: "teacher" | "admin";
  status: "pending" | "active" | "suspended";
  created_at: string;
  last_login_at: string | null;
}

export interface AppCtx {
  env: Env;
  cfg: GradeConfig;
  user: UserRow | null;
  ip: string | null;
}

export function userOut(u: { id: string; email: string; display_name: string; role: string; status: string }): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    role: u.role,
    status: u.status,
  };
}

export async function getOptionalUser(c: Context<{ Bindings: Env }>): Promise<AppCtx> {
  const env = c.env;
  const cfg = loadConfig(env);
  let user: UserRow | null = null;
  const token = getCookie(c, cfg.sessionCookieName);
  if (token) {
    const payload = await decodeSessionToken(env.SESSION_SECRET, token);
    if (payload?.sub) {
      user = await one<UserRow>(
        env.DB,
        "SELECT id, email, display_name, role, status, created_at, last_login_at FROM users WHERE id = ?",
        payload.sub,
      );
      if (user && user.status === "suspended") {
        // 停用立即拒绝(与原 get_current_user 一致)
        throw new HttpError(403, "账号已被停用,请联系管理员");
      }
    }
  }
  return { env, cfg, user, ip: clientIp(c.req.raw) };
}

export function requireUser(ctx: AppCtx): UserRow {
  if (!ctx.user) throw new HttpError(401, "未登录或会话已过期");
  return ctx.user;
}

export function requireActive(ctx: AppCtx): UserRow {
  const u = requireUser(ctx);
  if (u.status !== "active") throw new HttpError(403, "账号未开通,请联系管理员");
  return u;
}

export function requireAdmin(ctx: AppCtx): UserRow {
  const u = requireUser(ctx);
  if (u.role !== "admin") throw new HttpError(403, "需要管理员权限");
  return u;
}

export interface ProjectRow {
  id: string;
  owner_id: string;
  title: string;
  status: "active" | "archived" | "deleted";
  version_seq: number;
  created_at: string;
  updated_at: string;
}

/** 项目归属:不存在/已删除/非本人一律 404(防枚举,与原 get_project 一致)。 */
export async function getOwnedProject(
  ctx: AppCtx,
  projectId: string,
  opts: { write?: boolean } = {},
): Promise<ProjectRow> {
  const u = requireUser(ctx);
  const p = await one<ProjectRow>(
    ctx.env.DB,
    "SELECT * FROM projects WHERE id = ?",
    projectId,
  );
  if (!p || p.status === "deleted" || p.owner_id !== u.id) {
    throw new HttpError(404, "项目不存在或无权访问");
  }
  return p;
}

export async function audit(
  ctx: AppCtx,
  action: string,
  opts: { entityId?: string; detail?: string; actorEmail?: string | null } = {},
): Promise<void> {
  await run(
    ctx.env.DB,
    "INSERT INTO audit_logs (id, actor_email, action, entity_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    crypto.randomUUID(),
    opts.actorEmail !== undefined ? opts.actorEmail : ctx.user?.email ?? null,
    action,
    opts.entityId ?? null,
    opts.detail ?? null,
    ctx.ip,
    nowIso(),
  );
}
