/**
 * 安全中间件(P0.1)—— 必须注册在所有 API 路由之前。
 *
 * 顺序问题:此前 Origin 校验 use() 注册在路由之后,Hono 按注册顺序执行,
 * 受保护端点会先跑业务逻辑再被拒 —— 跨站写请求已产生副作用(如验证码已发)。
 *
 * 现在的边界策略(结合 Cookie SameSite=Lax + HttpOnly):
 * - 写方法(POST/PATCH/DELETE/PUT):
 *   1) Sec-Fetch-Site 存在且为 cross-site → 403(Fetch Metadata,浏览器强制可信);
 *   2) Origin 头存在 → 必须与请求 host 同源(URL 解析 + 端口归一化;
 *      解析失败视为非法 Origin → 403);缺失 Origin 放行(非浏览器客户端,
 *      如 curl/测试 —— Cookie 为 HttpOnly+SameSite=Lax,跨站浏览器请求本就带不上)。
 * - 所有响应(含 GET/错误/SSE/下载)统一追加安全头。
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** 归一化 protocol+host(去默认端口),用于同源判定。 */
export function originKey(protocol: string, host: string): string {
  let h = (host || "").toLowerCase();
  const p = protocol.toLowerCase();
  if (p === "https:") h = h.replace(/:443$/, "");
  if (p === "http:") h = h.replace(/:80$/, ""); // :8080 不受影响($ 锚定)
  return `${p}//${h}`;
}

/** 判定 Origin 是否与请求同源;origin 非法时返回 false。 */
export function isSameOrigin(origin: string | undefined, requestUrl: string, hostHeader: string | undefined): boolean {
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const req = new URL(requestUrl);
  const host = hostHeader || req.host;
  // host 头可能带端口;Origin 的 host 亦可能省略默认端口 —— 双方归一化后比较
  return originKey(o.protocol, o.host) === originKey(req.protocol, host);
}

export function securityHeaders(res: Response): Response {
  res.headers.set("x-content-type-options", "nosniff");
  res.headers.set("referrer-policy", "same-origin");
  res.headers.set("x-robots-tag", "noindex, nofollow");
  res.headers.set("content-security-policy", "frame-ancestors 'self'");
  return res;
}

/** Hono 中间件:跨站防护 + 安全头。必须在任何路由注册之前 use。 */
export async function securityMiddleware(c: any, next: () => Promise<void>): Promise<Response | void> {
  const method = c.req.method.toUpperCase();
  if (!SAFE_METHODS.has(method)) {
    const fetchSite = (c.req.header("sec-fetch-site") || "").toLowerCase();
    if (fetchSite === "cross-site") {
      return c.json({ detail: "跨站请求被拒绝" }, 403);
    }
    const origin = c.req.header("origin");
    if (origin) {
      // URL 解析失败(非法 Origin)→ 403;解析成功但非同源 → 403
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        return c.json({ detail: "跨站请求被拒绝" }, 403);
      }
      if (!parsed.protocol.startsWith("http")) {
        return c.json({ detail: "跨站请求被拒绝" }, 403);
      }
      const host = c.req.header("host") || new URL(c.req.url).host;
      if (!isSameOrigin(origin, c.req.url, host)) {
        return c.json({ detail: "跨站请求被拒绝" }, 403);
      }
    }
    // Origin 缺失:非浏览器客户端放行(Cookie SameSite=Lax + HttpOnly 已挡跨站携带)
  }
  await next();
  securityHeaders(c.res);
  return;
}
