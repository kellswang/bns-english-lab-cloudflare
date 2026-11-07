/**
 * 测试环境:wrangler getPlatformProxy 提供真实的本地 D1(workerd SQLite)与 R2。
 * 不需要 Cloudflare 账户;线上行为以授权后的真实部署验证为准。
 */
import { getPlatformProxy } from "wrangler";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import app from "../src/index";
import type { Env } from "../src/types";

const here = dirname(fileURLToPath(import.meta.url));

export async function makeTestEnv() {
  const proxy = await getPlatformProxy<Record<string, unknown>>({
    configPath: "./wrangler.test.jsonc",
    persist: false, // 每次全新内存实例:测试间互不污染
  });
  const env = proxy.env as unknown as Env;
  env.SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789abcdef";
  env.OTP_SECRET = "test-otp-secret-0123456789abcdef0123456789abcdef";
  env.RESEND_API_KEY = "";
  env.AI_API_KEY = "test-ai-key";
  env.CHAT_API_KEY = "test-chat-key";

  // 应用迁移(按文件名顺序);先剥掉注释行再按分号拆分;幂等(表已存在则跳过)
  const migDir = join(here, "../../../db/migrations");
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  const existing = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").first();
  if (!existing) {
    for (const f of files) {
      const sql = readFileSync(join(migDir, f), "utf-8").replace(/^--.*$/gm, "");
      for (const stmt of sql.split(/;\s*\n/)) {
        const trimmed = stmt.trim();
        if (!trimmed) continue;
        await env.DB.prepare(trimmed).run();
      }
    }
  }
  return { env, dispose: proxy.dispose };
}

export function req(
  env: Env,
  path: string,
  init: { method?: string; body?: unknown; cookie?: string; form?: FormData; ip?: string } = {},
): Request {
  const headers: Record<string, string> = {};
  if (init.body !== undefined && !init.form) headers["content-type"] = "application/json";
  if (init.cookie) headers["cookie"] = init.cookie;
  if (init.ip) headers["cf-connecting-ip"] = init.ip;
  return new Request(`https://worker.test${path}`, {
    method: init.method || (init.body !== undefined || init.form ? "POST" : "GET"),
    headers,
    body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
}

export async function call(
  env: Env,
  path: string,
  init: Parameters<typeof req>[2] = {},
): Promise<Response> {
  return app.fetch(req(env, path, init), env, { waitUntil: () => {} } as unknown as ExecutionContext);
}

/** 通过发码(mock 返回 dev_code)+ 验证拿到会话 Cookie。 */
export async function login(
  env: Env,
  email: string,
): Promise<string> {
  const codeRes = await call(env, "/api/v1/auth/email/code", { body: { email } });
  if (codeRes.status !== 202) {
    throw new Error(`发码失败 ${codeRes.status}: ${await codeRes.text()}`);
  }
  const { dev_code: code } = await codeRes.json<{ dev_code?: string }>();
  if (!code) throw new Error("测试环境未返回 dev_code");
  const verifyRes = await call(env, "/api/v1/auth/email/verify", {
    body: { email, code, trust_device: false },
  });
  if (verifyRes.status !== 200) {
    throw new Error(`验证失败 ${verifyRes.status}: ${await verifyRes.text()}`);
  }
  const cookie = (verifyRes.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("未获得会话 Cookie");
  return cookie;
}

/** 直接插入白名单(测试教师用占位邮箱)。 */
export async function seedInvite(env: Env, email: string, name: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO teacher_invites (id, email, real_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
  ).bind(crypto.randomUUID(), email, name, new Date().toISOString(), new Date().toISOString()).run();
}

export { app };
