/**
 * 校内邮箱一次性验证码 —— 对应原 backend/app/email_auth.py。
 * 规则一致:6 位数字 / 5 分钟 / 单次核销 / 最多 5 次尝试 / 60 秒重发冷却 /
 * 单邮箱 10 封每小时、单 IP 30 封每小时(可豁免 IP)/ 数据库只存 HMAC 摘要 /
 * 白名单校验发生在写验证码记录之前 / 并发靠原子 UPSERT 与条件 UPDATE。
 */
import type { Context } from "hono";
import { hashCode, constantTimeEqual } from "../auth/tokens";
import { loadConfig, type GradeConfig } from "../config";
import type { Env } from "../types";
import { HttpError } from "../utils/http";
import { changes, one, run } from "../storage/db";

const LOCAL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function normalizeEmail(cfg: GradeConfig, raw: string): string {
  const value = (raw || "").trim().toLowerCase();
  if (!value) throw new HttpError(400, "请输入校内邮箱地址");
  if (value.split("@").length !== 2) throw new HttpError(400, "请输入完整的校内邮箱地址");
  const parts = value.split("@");
  const local = parts[0] ?? "";
  const domain = parts[1] ?? "";
  if (domain !== cfg.emailDomain) {
    throw new HttpError(400, `只支持 @${cfg.emailDomain} 校内邮箱`);
  }
  if (!LOCAL_RE.test(local)) {
    throw new HttpError(400, "邮箱前缀只能包含小写字母、数字、点、下划线和短横线");
  }
  return `${local}@${domain}`;
}

export interface InviteRow {
  id: string;
  email: string;
  real_name: string;
  status: "active" | "disabled";
  user_id: string | null;
}

export async function getInvite(env: Env, email: string): Promise<InviteRow | null> {
  return one<InviteRow>(env.DB, "SELECT * FROM teacher_invites WHERE email = ?", email.toLowerCase());
}

async function requireInvited(env: Env, cfg: GradeConfig, email: string): Promise<InviteRow> {
  const invite = await getInvite(env, email);
  if (!invite) {
    // 不在名单:绝不写验证码记录,绝不发信
    throw Object.assign(new HttpError(403, { message: "当前账号尚未获得使用权限", code: "not_invited" }), { code: "not_invited" });
  }
  if (invite.status !== "active") {
    throw Object.assign(new HttpError(403, { message: "该账号访问权限已停用", code: "invite_disabled" }), { code: "invite_disabled" });
  }
  return invite;
}

/** 冷却闸门(原子):窗口内重复请求返回还需等待的秒数。 */
async function cooldownOk(env: Env, key: string, seconds: number, nowIso: string): Promise<number> {
  // SQLite 时间戳以毫秒整数比较,避免文本时区歧义
  const now = Date.now();
  const inserted = await run(
    env.DB,
    "INSERT INTO rate_limit_counters (key, window_start, hits, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO NOTHING",
    key, String(now + seconds * 1000), nowIso,
  );
  if (inserted.meta.changes === 1) return 0;
  const renewed = await changes(
    env.DB,
    "UPDATE rate_limit_counters SET window_start = ?, hits = hits + 1, updated_at = ? WHERE key = ? AND CAST(window_start AS INTEGER) <= ?",
    String(now + seconds * 1000), nowIso, key, String(now),
  );
  if (renewed === 1) return 0;
  const prev = await one<{ window_start: string }>(env.DB, "SELECT window_start FROM rate_limit_counters WHERE key = ?", key);
  if (!prev) return 0;
  return Math.max(1, Math.ceil((Number(prev.window_start) - now) / 1000));
}

/** 小时窗口原子计数;超限退回一次计数并返回 false。 */
async function bumpHour(env: Env, key: string, limit: number, nowIso: string): Promise<boolean> {
  const row = await one<{ hits: number }>(
    env.DB,
    "INSERT INTO rate_limit_counters (key, window_start, hits, updated_at) VALUES (?, ?, 1, ?) " +
    "ON CONFLICT(key) DO UPDATE SET hits = hits + 1, updated_at = excluded.updated_at RETURNING hits",
    key, String(Date.now()), nowIso,
  );
  const hits = row ? Number(row.hits) : 1;
  if (hits > limit) {
    await run(env.DB, "UPDATE rate_limit_counters SET hits = MAX(hits - 1, 0) WHERE key = ?", key);
    return false;
  }
  return true;
}

function hourKey(scope: string, value: string): string {
  const hour = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, "");
  return `code:send:hour:${scope}:${value}:${hour}`;
}

async function sendViaResend(env: Env, cfg: GradeConfig, email: string, code: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL,
      to: [email],
      subject: `${cfg.gradeLabel}英语教研平台 登录验证码`,
      text: `你的登录验证码是 ${code},5 分钟内有效。若非本人操作请忽略本邮件。`,
    }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    throw new HttpError(503, "验证码邮件发送失败,请稍后再试");
  }
}

export async function issueCode(
  c: Context<{ Bindings: Env }>,
  rawEmail: string,
): Promise<Record<string, unknown>> {
  const env = c.env;
  const cfg = loadConfig(env);
  const email = normalizeEmail(cfg, rawEmail);
  const nowIso = new Date().toISOString();

  // 白名单校验必须在发送与写记录之前
  await requireInvited(env, cfg, email);

  const wait = await cooldownOk(env, `code:send:cd:${email}`, 60, nowIso);
  if (wait > 0) throw new HttpError(429, `请 ${wait} 秒后再重新发送`, { "retry-after": String(wait) });

  const exemptEmail = false; // 原项目 EXEMPT_EMAILS 保留位;年级实例默认不豁免邮箱
  if (!exemptEmail) {
    if (!(await bumpHour(env, hourKey("email", email), 10, nowIso))) {
      throw new HttpError(429, "该邮箱请求过于频繁,请稍后再试", { "retry-after": "600" });
    }
    const ip = c.req.header("cf-connecting-ip");
    if (ip && !cfg.exemptIps.has(ip)) {
      if (!(await bumpHour(env, hourKey("ip", ip), 30, nowIso))) {
        throw new HttpError(429, "请求过于频繁,请稍后再试", { "retry-after": "600" });
      }
    }
  }

  // 同一邮箱只允许一条有效码:作废旧的
  await run(
    env.DB,
    "UPDATE email_login_codes SET consumed_at = ? WHERE email = ? AND consumed_at IS NULL",
    nowIso, email,
  );

  const rnd = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const code = String(rnd % 1_000_000).padStart(6, "0");
  const codeHash = await hashCode(env.OTP_SECRET, email, code);
  await run(
    env.DB,
    "INSERT INTO email_login_codes (id, email, code_hash, expires_at, attempts, max_attempts, request_ip, created_at) VALUES (?, ?, ?, ?, 0, 5, ?, ?)",
    crypto.randomUUID(), email, codeHash,
    new Date(Date.now() + 5 * 60 * 1000).toISOString(), c.req.header("cf-connecting-ip") ?? null, nowIso,
  );

  if (env.RESEND_API_KEY) {
    await sendViaResend(env, cfg, email, code);
  } else if (cfg.env === "production") {
    // 生产环境缺密钥直接失败,绝不静默降级
    throw new HttpError(503, "验证码服务未配置,请联系管理员");
  }
  const out: Record<string, unknown> = { email, expires_in: 300, resend_after: 60 };
  if (cfg.emailDevShowCode && !env.RESEND_API_KEY) out.dev_code = code;
  return out;
}

export async function verifyCode(
  c: Context<{ Bindings: Env }>,
  rawEmail: string,
  given: string,
): Promise<string> {
  const env = c.env;
  const cfg = loadConfig(env);
  const email = normalizeEmail(cfg, rawEmail);
  if (!/^\d{6}$/.test((given || "").trim())) {
    throw new HttpError(400, "验证码是 6 位数字");
  }
  const row = await one<{ id: string; code_hash: string; expires_at: string; attempts: number; max_attempts: number; consumed_at: string | null }>(
    env.DB,
    "SELECT id, code_hash, expires_at, attempts, max_attempts, consumed_at FROM email_login_codes " +
    "WHERE email = ? AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1",
    email,
  );
  if (!row) throw new HttpError(400, "请先获取验证码");

  const nowIso = new Date().toISOString();
  // 原子占用一次尝试机会:未消费、未过期、次数未满
  const claimed = await changes(
    env.DB,
    "UPDATE email_login_codes SET attempts = attempts + 1 WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < max_attempts",
    row.id, nowIso,
  );
  if (claimed === 0) {
    const cur = await one<{ consumed_at: string | null; expires_at: string }>(
      env.DB, "SELECT consumed_at, expires_at FROM email_login_codes WHERE id = ?", row.id);
    if (cur?.consumed_at) throw new HttpError(400, "验证码已使用,请重新获取");
    if (cur && cur.expires_at <= nowIso) {
      await run(env.DB, "UPDATE email_login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", nowIso, row.id);
      throw new HttpError(400, "验证码已过期,请重新获取");
    }
    throw new HttpError(429, "验证码尝试次数过多,请重新获取");
  }

  const hash = await hashCode(env.OTP_SECRET, email, given.trim());
  if (!constantTimeEqual(row.code_hash, hash)) {
    const left = Math.max(0, row.max_attempts - (row.attempts + 1));
    if (left <= 0) {
      await run(env.DB, "UPDATE email_login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL", nowIso, row.id);
      throw new HttpError(429, "验证码错误次数过多,请重新获取");
    }
    throw new HttpError(401, `验证码不正确,还可尝试 ${left} 次`);
  }

  // 正确:原子消费,只有一次能成功
  const consumed = await changes(
    env.DB,
    "UPDATE email_login_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
    nowIso, row.id,
  );
  if (consumed === 0) throw new HttpError(400, "验证码已被使用,请重新获取");
  return email;
}

export async function getOrCreateUser(
  env: Env,
  cfg: GradeConfig,
  email: string,
): Promise<{ id: string; email: string; display_name: string; role: string; status: string }> {
  const invite = await getInvite(env, email);
  if (!invite) throw new HttpError(403, { message: "当前账号尚未获得使用权限", code: "not_invited" });
  if (invite.status !== "active") throw new HttpError(403, "该账号访问权限已停用");

  const existing = await one<{ id: string; email: string; display_name: string; role: string; status: string }>(
    env.DB, "SELECT id, email, display_name, role, status FROM users WHERE email = ?", email);
  const nowIso = new Date().toISOString();

  if (!existing) {
    const id = crypto.randomUUID();
    const role = cfg.adminEmails.has(email) ? "admin" : "teacher";
    await run(
      env.DB,
      "INSERT INTO users (id, email, display_name, role, status, email_verified_at, created_at, approved_at, approved_by) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, 'system:email_verified')",
      id, email, invite.real_name, role, nowIso, nowIso, nowIso,
    );
    await run(env.DB, "UPDATE teacher_invites SET user_id = ?, updated_at = ? WHERE id = ?", id, nowIso, invite.id);
    return { id, email, display_name: invite.real_name, role, status: "active" };
  }

  if (existing.status === "suspended") throw new HttpError(403, "该账号已被停用,请联系管理员");
  // 姓名以白名单为准;停用同步;ADMIN_EMAILS 补提权
  const display = invite.real_name || existing.display_name;
  const role = cfg.adminEmails.has(email) && existing.role !== "admin" ? "admin" : existing.role;
  await run(
    env.DB,
    "UPDATE users SET display_name = ?, role = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?",
    display, role, nowIso, existing.id,
  );
  if (invite.user_id !== existing.id) {
    await run(env.DB, "UPDATE teacher_invites SET user_id = ?, updated_at = ? WHERE id = ?", existing.id, nowIso, invite.id);
  }
  return { ...existing, display_name: display, role, status: "active" };
}
