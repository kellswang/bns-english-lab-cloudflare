/** P0.1 安全中间件回归:同源放行 / 跨站拒绝 / 非法 Origin / 缺失 Origin / 安全头 / 端口归一化。 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTestCtx, type TestCtx } from "./env";
import { call, seedInvite } from "../helpers";
import { originKey, isSameOrigin } from "../../src/middleware/security";

let ctx: TestCtx;
beforeAll(async () => { ctx = await makeTestCtx(); });
afterAll(async () => { await ctx.dispose(); });

describe("originKey / isSameOrigin 纯函数", () => {
  it("默认端口归一化", () => {
    expect(originKey("https:", "example.com:443")).toBe("https://example.com");
    expect(originKey("https:", "example.com")).toBe("https://example.com");
    expect(originKey("http:", "example.com:80")).toBe("http://example.com");
    expect(originKey("http:", "example.com:8080")).toBe("http://example.com:8080");
    expect(originKey("http:", "example.com:8081")).not.toBe(originKey("http:", "example.com:8080"));
  });

  it("isSameOrigin 边界", () => {
    const url = "https://school.example.edu/api/v1/x";
    expect(isSameOrigin("https://school.example.edu", url, "school.example.edu")).toBe(true);
    expect(isSameOrigin("https://school.example.edu:443", url, "school.example.edu")).toBe(true);
    expect(isSameOrigin("https://evil.example.edu", url, "school.example.edu")).toBe(false);
    expect(isSameOrigin("http://school.example.edu", url, "school.example.edu")).toBe(false); // 协议不同
    expect(isSameOrigin("not a url", url, "school.example.edu")).toBe(false); // 非法
    expect(isSameOrigin(undefined, url, "school.example.edu")).toBe(false); // 缺失
    expect(isSameOrigin("https://school.example.edu", url, undefined)).toBe(true); // 用 req.url host 兜底
  });
});

describe("安全中间件(真实请求)", () => {
  it("合法同源 POST 正常执行(不被拒)", async () => {
    // 白名单外邮箱 → 403 not_invited(业务响应,而非跨站拒绝)
    const res = await call(ctx.env, "/api/v1/auth/email/code", {
      body: { email: "never-invited@example.edu" },
      headers: { origin: "https://worker.test" },
    });
    expect(res.status).toBe(403);
    const body = await res.json<{ detail: { code?: string } | string }>();
    expect(JSON.stringify(body.detail)).toContain("not_invited");
  });

  it("非法跨站 Origin POST → 403 跨站拒绝", async () => {
    const res = await call(ctx.env, "/api/v1/auth/email/code", {
      body: { email: "x@example.edu" },
      headers: { origin: "https://evil.example.net" },
    });
    expect(res.status).toBe(403);
    expect((await res.json<{ detail: string }>()).detail).toContain("跨站");
  });

  it("非法 Origin 字符串 POST → 403", async () => {
    const res = await call(ctx.env, "/api/v1/auth/email/code", {
      body: { email: "x@example.edu" },
      headers: { origin: "not-a-url" },
    });
    expect(res.status).toBe(403);
  });

  it("Sec-Fetch-Site: cross-site → 403(即使 Origin 缺失)", async () => {
    const res = await call(ctx.env, "/api/v1/auth/email/code", {
      body: { email: "x@example.edu" },
      headers: { "sec-fetch-site": "cross-site" } as any,
    });
    expect(res.status).toBe(403);
  });

  it("缺失 Origin(非浏览器客户端)POST 放行", async () => {
    const res = await call(ctx.env, "/api/v1/auth/email/code", { body: { email: "x@example.edu" } });
    expect([403, 422]).toContain(res.status); // 业务结果,非跨站拒绝
  });

  it("GET 响应带全部安全头", async () => {
    const res = await call(ctx.env, "/api/v1/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors");
  });

  it("POST 错误响应(404)同样带安全头", async () => {
    const res = await call(ctx.env, "/api/v1/nonexistent", { method: "POST", body: {} });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("登录流程在中间件重排后不受影响(同源无 Origin 的测试请求照常)", async () => {
    await seedInvite(ctx.env, "sec-teacher@example.edu", "安全教师");
    const code = await call(ctx.env, "/api/v1/auth/email/code", { body: { email: "sec-teacher@example.edu" } });
    expect(code.status).toBe(202);
  });
});
