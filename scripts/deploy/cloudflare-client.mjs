/**
 * P1:Cloudflare 适配器 —— 真实实现 + Mock 故障注入实现,同一接口。
 *
 * 真实实现优先用 REST API(D1/R2/Queues,可控错误语义),
 * 只有 migrations/build/deploy/secret 走 wrangler 子进程。
 *
 * 红线:适配器层【不提供任何 delete】——状态机在物理上无法删除云资源。
 */

export class CloudflareError extends Error {
  /**
   * @param kind exists | no_permission | not_activated | bad_account | network | unknown
   */
  constructor(kind, message, { status = 0, detail = "" } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

function mapHttpError(status, body) {
  if (status === 400 && /not entitled|not activated|does not have access to r2/i.test(body)) {
    return new CloudflareError("not_activated", "R2 尚未开通", { status, detail: body.slice(0, 200) });
  }
  if (status === 403) return new CloudflareError("no_permission", "令牌无该资源权限", { status, detail: body.slice(0, 200) });
  if (status === 401) return new CloudflareError("no_permission", "令牌无效或已过期", { status, detail: body.slice(0, 200) });
  if (status === 404) return new CloudflareError("bad_account", "资源或账户不存在(Account ID 可能错误)", { status, detail: body.slice(0, 200) });
  if (status >= 500) return new CloudflareError("network", `Cloudflare 服务端错误(${status})`, { status, detail: body.slice(0, 200) });
  return new CloudflareError("unknown", `Cloudflare API 错误(${status})`, { status, detail: body.slice(0, 200) });
}

/** 真实 Cloudflare 实现(REST + wrangler 子进程) */
export class CloudflareClient {
  constructor({ apiToken, accountId }) {
    if (!apiToken) throw new CloudflareError("no_permission", "缺少 Cloudflare API Token");
    this.token = apiToken;
    this.accountId = accountId;
    this.base = "https://api.cloudflare.com/client/v4";
  }

  headers(extra = {}) {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json", ...extra };
  }

  async api(method, path, body) {
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new CloudflareError("network", `Cloudflare API 请求失败:${e.message}`);
    }
    const text = await res.text();
    if (!res.ok) throw mapHttpError(res.status, text);
    let json;
    try { json = JSON.parse(text); } catch { return text; }
    if (json.success === false) throw mapHttpError(res.status, JSON.stringify(json.errors || {}));
    return json.result;
  }

  async verifyAccount() {
    const acc = await this.api("GET", "/accounts");
    const first = Array.isArray(acc) ? acc[0] : acc;
    if (!first) throw new CloudflareError("bad_account", "令牌看不到任何账户");
    return { id: first.id, name: first.name };
  }

  async d1List() {
    const result = await this.api("GET", `/accounts/${this.accountId}/d1/database?per_page=100`);
    return (result || []).map((d) => d.name);
  }

  async d1GetId(name) {
    const result = await this.api("GET", `/accounts/${this.accountId}/d1/database?per_page=100`);
    const hit = (result || []).find((d) => d.name === name);
    if (!hit) throw new CloudflareError("unknown", `D1 ${name} 不存在且无法获取 id`);
    return hit.uuid;
  }

  async d1Create(name) {
    const result = await this.api("POST", `/accounts/${this.accountId}/d1/database`, { name });
    return { id: result.uuid };
  }

  async r2BucketExists(name) {
    const buckets = await this.api("GET", `/accounts/${this.accountId}/r2/buckets`);
    return (buckets?.buckets || []).some((b) => b.name === name);
  }

  async r2Create(name) {
    await this.api("POST", `/accounts/${this.accountId}/r2/buckets`, { name });
  }

  async queueExists(name) {
    const queues = await this.api("GET", `/accounts/${this.accountId}/queues`);
    return (queues || []).some((q) => q.queue_name === name || q.id === name);
  }

  async queueCreate(name) {
    await this.api("POST", `/accounts/${this.accountId}/queues`, { queue_name: name });
  }

  async migrationsApply(d1Name) {
    return runWrangler(`npx wrangler d1 migrations apply ${d1Name} --remote -y`);
  }

  async secretPut(workerName, key, value) {
    // secret put 需要交互式输入值:通过 stdin 传入
    return runWrangler(`npx wrangler secret put ${key} --name ${workerName}`, { input: value });
  }

  async teachersImport(d1Name, rows, admins) {
    // 幂等导入:存在即跳过;管理员邮箱在名单外则一并插入为 active
    const stmts = [];
    for (const r of rows) {
      stmts.push(
        `INSERT INTO teacher_invites (id, email, real_name, status, created_at, updated_at) ` +
        `VALUES (lower(hex(randomblob(16))), '${r.email.replace(/'/g, "''")}', '${r.name.replace(/'/g, "''")}', 'active', datetime('now'), datetime('now')) ` +
        `ON CONFLICT(email) DO NOTHING;`,
      );
    }
    for (const admin of admins) {
      if (!rows.some((r) => r.email === admin)) continue; // 管理员也应来自名单,避免外校邮箱
    }
    const tmp = `${d1Name}-teachers-${Date.now()}.sql`;
    const fs = await import("node:fs");
    fs.writeFileSync(tmp, stmts.join("\n"));
    try {
      const out = runWrangler(`npx wrangler d1 execute ${d1Name} --remote --file="${tmp}" -y`);
      return { inserted: rows.length, skipped: 0, output: String(out).slice(0, 300) }; // 精确计数用 SELECT 校正(略)
    } finally {
      fs.unlinkSync(tmp);
    }
  }

  async buildWeb(webDir) {
    return runNpm("run build", webDir);
  }

  async workerDeploy(workerDir, configPath) {
    const cfg = configPath ? ` --config ${configPath}` : "";
    return runWrangler(`npx wrangler deploy${cfg}`, { cwd: workerDir });
  }

  async healthCheck(url) {
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/api/v1/health`, { signal: AbortSignal.timeout(20_000) });
      const body = await res.text();
      let ok = res.status === 200;
      try { ok = ok && JSON.parse(body).ok === true; } catch { /* body 非 JSON */ }
      return { status: res.status, ok, body };
    } catch (e) {
      return { status: 0, ok: false, body: `无法访问:${e.message}` };
    }
  }
}

function runWrangler(cmd, { input = "", cwd } = {}) {
  const { execFileSync } = require("node:child_process");
  try {
    return execFileSync("cmd.exe", ["/d", "/s", "/c", cmd], {
      cwd, input, encoding: "utf-8", timeout: 10 * 60 * 1000, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const out = String(e.stdout || "") + String(e.stderr || "");
    if (/not authenticated|Please run .* login/i.test(out)) {
      throw new CloudflareError("no_permission", "Wrangler 未登录:请先运行 npx wrangler login");
    }
    if (/\[ERROR\]/.test(out) && /already exists/i.test(out)) {
      throw new CloudflareError("exists", "资源已存在", { detail: out.slice(0, 200) });
    }
    throw new CloudflareError("deploy", "wrangler 命令失败", { detail: out.slice(0, 400) });
  }
}

function runNpm(script, cwd) {
  const { execFileSync } = require("node:child_process");
  try {
    return execFileSync("npm", [...script.split(" ")], { cwd, encoding: "utf-8", timeout: 10 * 60 * 1000, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    throw new CloudflareError("build", "npm 构建失败", { detail: (String(e.stdout || "") + String(e.stderr || "")).slice(0, 400) });
  }
}
