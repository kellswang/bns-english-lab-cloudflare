/**
 * 会话令牌与验证码摘要 — 对应原 backend/app/security.py。
 *
 * 原实现:PyJWT HS256(iss=english-lab, sub/role/rmb/jti/iat/exp)。
 * Workers 无 PyJWT,这里用 WebCrypto HMAC-SHA256 实现等价的最小 JWT:
 * 仅支持 HS256 签发/校验,校验 issuer 与 exp,不做其它算法(防算法混淆)。
 */
const ISSUER = "english-lab";
const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 ? 4 - (str.length % 4) : 0;
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export interface SessionPayload {
  sub: string;
  role: string;
  rmb: 0 | 1;
  jti: string;
  iat: number;
  exp: number;
}

export async function createSessionToken(
  secret: string,
  opts: { userId: string; role: string; days: number; remember: boolean },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: opts.userId,
    role: opts.role,
    rmb: opts.remember ? 1 : 0,
    jti: b64urlEncode(crypto.getRandomValues(new Uint8Array(12))),
    iat: now,
    exp: now + opts.days * 86400,
  };
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function decodeSessionToken(
  secret: string,
  token: string,
): Promise<SessionPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = parts[0];
  const body = parts[1];
  const sig = parts[2];
  if (!header || !body || !sig) return null;
  // 只接受 HS256(防 alg:none / 算法混淆)
  try {
    const h = JSON.parse(new TextDecoder().decode(b64urlDecode(header)));
    if (h.alg !== "HS256") return null;
  } catch {
    return null;
  }
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC", key,
    b64urlDecode(sig),
    enc.encode(`${header}.${body}`),
  );
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
    if (!payload.exp || !payload.sub) return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 验证码 HMAC 摘要:hash_code(email, code) = HMAC-SHA256(secret, "email:code") 十六进制 */
export async function hashCode(secret: string, email: string, code: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${email}:${code}`));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 常数时间比较(十六进制摘要等长字符串) */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** UTC ISO 时间(毫秒 + Z);D1 存 TEXT,展示层换算北京时间 */
export function utcNow(): string {
  return new Date().toISOString();
}
