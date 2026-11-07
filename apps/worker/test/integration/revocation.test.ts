/**
 * P0.6:白名单停用即时撤销 —— 已有会话在 invite 被禁用后立即失效,
 * 不能继续读取项目/图片/聊天/附件;审计日志保留。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTestCtx, type TestCtx } from "./env";
import { call, login, seedInvite } from "../helpers";

let ctx: TestCtx;
let cookie: string;
let adminCookie: string;
let pid: string;
const EMAIL = "revoke-teacher@example.edu";

beforeAll(async () => {
  ctx = await makeTestCtx();
  await seedInvite(ctx.env, EMAIL, "撤销教师");
  await seedInvite(ctx.env, "admin@example.edu", "撤销管理员");
  cookie = await login(ctx.env, EMAIL);
  adminCookie = await login(ctx.env, "admin@example.edu");
  const p = await call(ctx.env, "/api/v1/projects", { body: { title: "撤销前项目" }, cookie });
  pid = (await p.json<{ id: string }>()).id;
});

afterAll(async () => { await ctx.dispose(); });

async function disableInvite(email: string) {
  await ctx.env.DB.prepare("UPDATE teacher_invites SET status = 'disabled', updated_at = ? WHERE email = ?")
    .bind(new Date().toISOString(), email).run();
}
async function enableInvite(email: string) {
  await ctx.env.DB.prepare("UPDATE teacher_invites SET status = 'active', updated_at = ? WHERE email = ?")
    .bind(new Date().toISOString(), email).run();
}

describe("白名单即时撤销(P0.6)", () => {
  it("禁用后:me / 项目 / 消息 / 对话 / 管理页全部立即 403", async () => {
    // 撤销前一切正常
    expect((await call(ctx.env, "/api/v1/auth/me", { cookie })).status).toBe(200);
    expect((await call(ctx.env, `/api/v1/projects/${pid}`, { cookie })).status).toBe(200);

    await disableInvite(EMAIL);

    expect((await call(ctx.env, "/api/v1/auth/me", { cookie })).status).toBe(403);
    expect((await call(ctx.env, `/api/v1/projects/${pid}`, { cookie })).status).toBe(403);
    expect((await call(ctx.env, `/api/v1/projects/${pid}/messages`, { cookie })).status).toBe(403);
    expect((await call(ctx.env, `/api/v1/projects/${pid}/versions`, { cookie })).status).toBe(403);
    expect((await call(ctx.env, "/api/v1/chat/conversations", { cookie })).status).toBe(403);
    expect((await call(ctx.env, "/api/v1/usage", { cookie })).status).toBe(403);
    // 写操作同样被拒
    expect((await call(ctx.env, "/api/v1/projects", { body: { title: "x" }, cookie })).status).toBe(403);
  });

  it("管理员不在白名单校验范围,不受影响;重新启用后教师恢复", async () => {
    await disableInvite(EMAIL);
    expect((await call(ctx.env, "/api/v1/admin/overview", { cookie: adminCookie })).status).toBe(200);

    await enableInvite(EMAIL);
    expect((await call(ctx.env, "/api/v1/auth/me", { cookie })).status).toBe(200);
    expect((await call(ctx.env, `/api/v1/projects/${pid}`, { cookie })).status).toBe(200);
  });

  it("撤销不删除审计日志与历史数据", async () => {
    await disableInvite(EMAIL);
    const logs = await call(ctx.env, "/api/v1/admin/logs?limit=50", { cookie: adminCookie });
    const body = await logs.json<{ items: Array<{ actor_email: string | null }> }>();
    expect(body.items.some((l) => l.actor_email === EMAIL)).toBe(true);
    const projects = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE owner_id = (SELECT id FROM users WHERE email = ?)")
      .bind(EMAIL).first<{ n: number }>();
    expect(Number(projects?.n)).toBeGreaterThan(0);
  });
});
