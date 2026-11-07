/** HTTP 工具:统一 JSON 响应、错误体、Cookie 与北京时间分组的 UTC 契约。 */

/** 原 FastAPI 错误体是 {"detail": "..."};业务错误带 reason 时为 {"detail": {...}}。
 *  前端 ApiError 只读 body.detail,必须保持字段名。 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public detail: string | Record<string, unknown>,
    public headers?: Record<string, string>,
  ) {
    super(typeof detail === "string" ? detail : (detail.message as string) || "请求失败");
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    const h: Record<string, string> = { ...(err.headers || {}) };
    if (err.status === 429 && !h["retry-after"]) h["retry-after"] = "60";
    return json({ detail: err.detail }, err.status, h);
  }
  console.error("unhandled error", err);
  return json({ detail: "服务器内部错误,请稍后重试" }, 500);
}

export function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie") || "";
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function setSessionCookie(
  headers: Headers,
  name: string,
  value: string,
  maxAgeDays: number,
  secure: boolean,
): void {
  headers.append(
    "set-cookie",
    `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.round(maxAgeDays * 86400)}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
  );
}

export function clearSessionCookie(headers: Headers, name: string): void {
  headers.append(
    "set-cookie",
    `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`,
  );
}

/**
 * 客户端 IP —— 与原 deps.client_ip 语义一致,但 Workers 上**只用 Cloudflare 注入的
 * 可信连接信息**(CF-Connecting-IP 由 Cloudflare 边缘强制写入,客户端不可伪造);
 * 绝不信任客户端可自行构造的 X-Forwarded-For / X-Real-IP。
 */
export function clientIp(req: Request): string | null {
  return req.headers.get("cf-connecting-ip")?.slice(0, 64) || null;
}

/**
 * 后端时间契约:返回 naive UTC ISO 字符串(不带时区后缀),
 * 前端 parseServerTime 会补 Z;登录/操作时间的展示统一换算北京时间。
 * 接受 Date 或 ISO 字符串(D1 TEXT 直接传回)。
 */
export function naiveUtc(d: Date | string = new Date()): string {
  const iso = typeof d === "string" ? d : d.toISOString();
  return iso.replace(/Z$/, "");
}

/** 解析 JSON body;失败回退默认值(与 `c.req.json().catch(() => ({}))` 等价但类型收窄)。 */
export async function jsonBody<T>(req: Request, fallback: T): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return fallback;
  }
}
