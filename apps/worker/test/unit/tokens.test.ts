/** 会话令牌与验证码摘要(对应 test_auth.py 的令牌部分)。 */
import { describe, it, expect } from "vitest";
import { createSessionToken, decodeSessionToken, hashCode, constantTimeEqual } from "../../src/auth/tokens";

const SECRET = "unit-test-secret-0123456789abcdef0123456789abcdef";

describe("会话令牌 HS256", () => {
  it("签发并校验,rmb/role 保留", async () => {
    const token = await createSessionToken(SECRET, { userId: "u1", role: "teacher", days: 30, remember: true });
    const payload = await decodeSessionToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe("u1");
    expect(payload!.role).toBe("teacher");
    expect(payload!.rmb).toBe(1);
  });

  it("错误密钥拒绝", async () => {
    const token = await createSessionToken(SECRET, { userId: "u1", role: "teacher", days: 1, remember: false });
    expect(await decodeSessionToken("another-secret-0123456789abcdef0123456789ab", token)).toBeNull();
  });

  it("篡改 payload 拒绝", async () => {
    const token = await createSessionToken(SECRET, { userId: "u1", role: "teacher", days: 1, remember: false });
    const [h, , s] = token.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: "admin-user", role: "admin", exp: Math.floor(Date.now() / 1000) + 9999 })).toString("base64url")}.${s}`;
    expect(await decodeSessionToken(SECRET, forged)).toBeNull();
  });

  it("过期拒绝", async () => {
    // 1 秒会话 + 手动等待不可行,直接构造已过期 payload 的签名:用 -1 天
    const token = await createSessionToken(SECRET, { userId: "u1", role: "teacher", days: -1, remember: false });
    expect(await decodeSessionToken(SECRET, token)).toBeNull();
  });

  it("非 HS256 算法头拒绝(alg 混淆防护)", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "u1", exp: 9999999999 })).toString("base64url");
    expect(await decodeSessionToken(SECRET, `${header}.${body}.x`)).toBeNull();
  });
});

describe("验证码 HMAC 摘要", () => {
  it("同一 email:code 摘要一致,不同 email/code 不同", async () => {
    const a1 = await hashCode(SECRET, "t@example.edu", "123456");
    const a2 = await hashCode(SECRET, "t@example.edu", "123456");
    const b = await hashCode(SECRET, "t@example.edu", "654321");
    const c = await hashCode(SECRET, "other@example.edu", "123456");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).not.toBe(c);
    expect(a1).toHaveLength(64);
  });

  it("常数时间比较", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
