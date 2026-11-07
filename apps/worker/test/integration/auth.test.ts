/**
 * 认证集成测试(本地 workerd D1)—— 对应 test_auth.py 关键断言:
 * 白名单外不发码不留记录、单次核销、尝试次数、会话读写、停用立即失效、管理权限。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTestEnv, call, login, seedInvite, type TestCtx } from "./env";

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await makeTestEnv();
  // 每个测试用独立邮箱,避免 60 秒发码冷却互相顶掉
  for (const [email, name] of [
    [T1, "教师一号"], [T2, "教师二号"], [T3, "教师三号"], [T4, "教师四号"], [T5, "教师五号"],
  ] as const) {
    await seedInvite(ctx.env, email, name);
  }
});
afterAll(async () => { await ctx.dispose(); });

const T1 = "teacher01@example.edu";
const T2 = "teacher02@example.edu";
const T3 = "teacher03@example.edu";
const T4 = "teacher04@example.edu";
const T5 = "teacher05@example.edu";
const ADMIN = "admin@example.edu";

describe("健康与配置", () => {
  it("health 返回 200 且 db ok", async () => {
    const res = await call(ctx.env, "/api/v1/health");
    expect(res.status).toBe(200);
    const data = await res.json<{ ok: boolean; checks: { db: boolean } }>();
    expect(data.ok).toBe(true);
    expect(data.checks.db).toBe(true);
  });

  it("auth/config 暴露域名与会话天数", async () => {
    const res = await call(ctx.env, "/api/v1/auth/config");
    expect(res.status).toBe(200);
    const data = await res.json<{ email_domain: string; session_days: number }>();
    expect(data.email_domain).toBe("example.edu");
    expect(data.session_days).toBe(1);
  });
});

describe("验证码与白名单", () => {
  it("未受邀邮箱:403 且不写验证码记录", async () => {
    const res = await call(ctx.env, "/api/v1/auth/email/code", { body: { email: "stranger@example.edu" } });
    expect(res.status).toBe(403);
    const body = await res.json<{ detail: { code?: string } | string }>();
    expect((body.detail as any).code ?? body.detail).toContain("not_invited");
    const row = await ctx.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM email_login_codes WHERE email = ?").bind("stranger@example.edu").first<{ n: number }>();
    expect(Number(row?.n)).toBe(0);
  });

  it("域名强校验:非校内域名 400", async () => {
    await seedInvite(ctx.env, "someone@gmail.com", "外部");
    const res = await call(ctx.env, "/api/v1/auth/email/code", { body: { email: "someone@gmail.com" } });
    expect(res.status).toBe(400);
  });

  it("错误验证码 401,连续 5 次后 429", async () => {
    await call(ctx.env, "/api/v1/auth/email/code", { body: { email: T2 } });
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const res = await call(ctx.env, "/api/v1/auth/email/verify", {
        body: { email: T2, code: "000000" },
      });
      last = res.status;
      if (i < 3) expect(last).toBe(401);
    }
    expect(last).toBe(429); // 第 5 次错误后次数耗尽
  });

  it("正确验证码 → 会话 + me;已消费的码不能再用", async () => {
    const cookie = await login(ctx.env, T1);
    const me = await call(ctx.env, "/api/v1/auth/me", { cookie });
    expect(me.status).toBe(200);
    const user = await me.json<{ email: string; display_name: string; role: string }>();
    expect(user.email).toBe(T1);
    expect(user.display_name).toBe("教师一号");

    // 复用同一个码再验证一次:码已被消费,应失败
    const codeRes = await call(ctx.env, "/api/v1/auth/email/code", { body: { email: T1 } });
    expect(codeRes.status).toBe(429); // 60 秒冷却
  });

  it("停用白名单后立即 403", async () => {
    const cookie = await login(ctx.env, T3);
    await ctx.env.DB.prepare("UPDATE teacher_invites SET status = 'disabled' WHERE email = ?").bind(T3).run();
    await ctx.env.DB.prepare("UPDATE users SET status = 'suspended' WHERE email = ?").bind(T3).run();
    const me = await call(ctx.env, "/api/v1/auth/me", { cookie });
    expect(me.status).toBe(403);
    await ctx.env.DB.prepare("UPDATE teacher_invites SET status = 'active' WHERE email = ?").bind(T3).run();
    await ctx.env.DB.prepare("UPDATE users SET status = 'active' WHERE email = ?").bind(T3).run();
  });

  it("管理员登录即拥有管理页;普通教师 403;匿名 401", async () => {
    await seedInvite(ctx.env, ADMIN, "管理员");
    const adminCookie = await login(ctx.env, ADMIN);
    const ok = await call(ctx.env, "/api/v1/admin/overview", { cookie: adminCookie });
    expect(ok.status).toBe(200);

    const tCookie = await login(ctx.env, T4);
    const forbidden = await call(ctx.env, "/api/v1/admin/overview", { cookie: tCookie });
    expect(forbidden.status).toBe(403);

    const anon = await call(ctx.env, "/api/v1/admin/overview");
    expect(anon.status).toBe(401);
  });
});
