/** /api/v1/auth/* —— 对应原 backend/app/api/auth.py,路径与响应字段保持兼容。 */
import { Hono } from "hono";
import type { Env } from "../types";
import { loadConfig } from "../config";
import { createSessionToken } from "../auth/tokens";
import { getOptionalUser, requireUser, userOut, audit, type UserRow } from "../auth/deps";
import { issueCode, verifyCode, getOrCreateUser } from "../auth/emailAuth";
import { HttpError, json, setSessionCookie, clearSessionCookie } from "../utils/http";

export const authRoutes = new Hono<{ Bindings: Env }>();

authRoutes.get("/auth/config", (c) => {
  const cfg = loadConfig(c.env);
  return json({
    app_name: `${cfg.gradeLabel}英语教研平台`,
    brand: `${cfg.gradeLabel}英语教研平台`,
    tagline: "图片创作平台",
    email_domain: cfg.emailDomain,
    session_days: cfg.sessionDays,
    provider: c.env.RESEND_API_KEY ? "resend" : "mock",
  });
});

authRoutes.post("/auth/email/code", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = typeof body?.email === "string" ? body.email : "";
  if (email.length < 3 || email.length > 160) {
    throw new HttpError(422, "邮箱格式不正确");
  }
  const out = await issueCode(c, email);
  return json({ ...out, provider: c.env.RESEND_API_KEY ? "resend" : "mock" }, 202);
});

authRoutes.post("/auth/email/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = typeof body?.email === "string" ? body.email : "";
  const code = typeof body?.code === "string" ? body.code : "";
  const trust = body?.trust_device !== false;
  const cfg = loadConfig(c.env);

  const verified = await verifyCode(c, email, code);
  const user = await getOrCreateUser(c.env, cfg, verified);

  const days = trust ? cfg.sessionDaysRemember : Math.max(1, cfg.sessionDays);
  const token = await createSessionToken(c.env.SESSION_SECRET, {
    userId: user.id, role: user.role, days, remember: trust,
  });
  const headers = new Headers();
  // Workers 上请求总是 HTTPS(本地 wrangler dev 除外);Secure 由协议决定
  const secure = new URL(c.req.url).protocol === "https:";
  setSessionCookie(headers, cfg.sessionCookieName, token, days, secure);

  const nowIso = new Date().toISOString();
  await c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(nowIso, user.id).run();
  await audit({
    env: c.env, cfg,
    user: { id: user.id, email: user.email, display_name: user.display_name, role: user.role as "teacher" | "admin", status: user.status as UserRow["status"], created_at: nowIso, last_login_at: null },
    ip: c.req.header("cf-connecting-ip") ?? null,
  }, "login", {
    actorEmail: user.email,
    detail: `邮箱验证码登录(${trust ? "记住设备" : "仅本次"},${days} 天会话)`,
  });

  return json(userOut(user), 200, {
    "set-cookie": headers.get("set-cookie") || "",
  });
});

authRoutes.post("/auth/logout", (c) => {
  const cfg = loadConfig(c.env);
  const headers = new Headers();
  clearSessionCookie(headers, cfg.sessionCookieName);
  return json({ ok: true }, 200, { "set-cookie": headers.get("set-cookie") || "" });
});

authRoutes.get("/auth/me", async (c) => {
  const ctx = await getOptionalUser(c);
  return json(userOut(requireUser(ctx)));
});
