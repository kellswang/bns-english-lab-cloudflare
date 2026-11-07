/**
 * 权限隔离 —— 对应 test_versions.py / test_chat.py 的隔离断言:
 * A 教师访问 B 的项目/版本/任务/对话/附件一律 404(与不存在不可区分)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTestCtx, type TestCtx } from "./env";
import { call, login, seedInvite } from "../helpers";

let ctx: TestCtx;
let cookieA: string;
let cookieB: string;
const A = "iso-a@example.edu";
const B = "iso-b@example.edu";

beforeAll(async () => {
  ctx = await makeTestCtx();
  await seedInvite(ctx.env, A, "甲教师");
  await seedInvite(ctx.env, B, "乙教师");
  cookieA = await login(ctx.env, A);
  cookieB = await login(ctx.env, B);
});

afterAll(async () => { await ctx.dispose(); });

describe("跨教师数据隔离", () => {
  let projectA: string;
  let versionA: string;
  let convA: string;

  it("准备 A 的项目与对话", async () => {
    const p = await call(ctx.env, "/api/v1/projects", { body: { title: "甲的私人项目" }, cookie: cookieA });
    projectA = (await p.json<{ id: string }>()).id;

    // 直接落一条版本(隔离测试只关心访问控制,不跑队列消费)
    versionA = crypto.randomUUID();
    await ctx.env.DB.prepare(
      "INSERT INTO versions (id, project_id, message_id, parent_id, source_version_id, version_no, branch_name, mode, model, prompt, params, rel_path, mime, size_bytes, is_starred, created_at) VALUES (?, ?, NULL, NULL, NULL, 1, 'MAIN', 'generate', 'gpt-image-2.6-flare', '甲的图', '{}', ?, 'image/png', 10, 0, ?)",
    ).bind(versionA, projectA, `versions/${projectA}/fake/original.png`, new Date().toISOString()).run();

    const c = await call(ctx.env, "/api/v1/chat/conversations", { body: { model: "gpt-6.1-sol", thinking: "standard" }, cookie: cookieA });
    convA = (await c.json<{ id: string }>()).id;
  });

  it("B 访问 A 的项目/版本/任务/图片 → 404", async () => {
    expect((await call(ctx.env, `/api/v1/projects/${projectA}`, { cookie: cookieB })).status).toBe(404);
    expect((await call(ctx.env, `/api/v1/projects/${projectA}/versions`, { cookie: cookieB })).status).toBe(404);
    expect((await call(ctx.env, `/api/v1/projects/${projectA}/messages`, { cookie: cookieB })).status).toBe(404);
    expect((await call(ctx.env, `/api/v1/projects/${projectA}/jobs`, { cookie: cookieB })).status).toBe(404);
    expect((await call(ctx.env, `/api/v1/versions/${versionA}/image`, { cookie: cookieB })).status).toBe(404);
    expect((await call(ctx.env, `/api/v1/versions/${versionA}/thumb`, { cookie: cookieB })).status).toBe(404);
    expect((await call(ctx.env, `/api/v1/versions/${versionA}/download`, { cookie: cookieB })).status).toBe(404);
    expect((await call(ctx.env, `/api/v1/versions/${versionA}`, { cookie: cookieB })).status).toBe(404);
  });

  it("B 访问 A 的对话与分支操作 → 404", async () => {
    expect((await call(ctx.env, `/api/v1/chat/conversations/${convA}`, { cookie: cookieB })).status).toBe(404);
    expect((await call(ctx.env, `/api/v1/chat/conversations/${convA}`, { method: "DELETE", cookie: cookieB })).status).toBe(404);
  });

  it("不存在的资源与越权返回一致(防枚举)", async () => {
    const ghost = crypto.randomUUID();
    expect((await call(ctx.env, `/api/v1/projects/${ghost}`, { cookie: cookieB })).status).toBe(404);
    expect((await call(ctx.env, `/api/v1/projects/${projectA}`, { cookie: cookieB })).status).toBe(404);
  });

  it("项目列表只含本人项目", async () => {
    const listB = await call(ctx.env, "/api/v1/projects?q=甲的私人项目", { cookie: cookieB });
    expect(listB.status).toBe(200);
    const body = await listB.json<{ items?: unknown[] }>();
    expect(body.items ?? []).toHaveLength(0);
    // A 自己能看到
    const listA = await call(ctx.env, "/api/v1/projects?q=甲的私人项目", { cookie: cookieA });
    const bodyA = await listA.json<{ items?: unknown[] }>();
    expect(bodyA.items ?? []).toHaveLength(1);
  });
});
