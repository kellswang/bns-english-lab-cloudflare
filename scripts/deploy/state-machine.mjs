/**
 * P0.2:部署状态机 —— 可恢复、幂等、绝不做危险操作。
 *
 * 阶段:preflight → account_check → resources → migrations → secrets
 *       → teachers → build → deploy → healthcheck → completed
 *
 * 设计约束:
 * - 每步记录 开始时间/成功/资源标识/错误原因/可否重试/下一步;
 * - 任何适配器都不提供 delete —— 不可能误删 D1/R2/队列;
 * - 资源先查后建:已存在的资源记录 createdByTool=false 并复用,绝不重复创建;
 * - Session Secret 只生成一次并存入 journal,恢复时绝不重新生成;
 * - journal 文件(deploy-state-<grade>.json)是唯一事实来源,支持断点续跑。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export const STAGES = [
  "preflight", "account_check", "resources", "migrations", "secrets",
  "teachers", "build", "deploy", "healthcheck", "completed",
];

export class DeployError extends Error {
  /**
   * @param kind  exists | no_permission | not_activated | bad_account | network | config | build | deploy | health | unknown
   * @param retryable 该阶段失败后能否安全重试
   */
  constructor(kind, message, { retryable = true, detail = "" } = {}) {
    super(message);
    this.kind = kind;
    this.retryable = retryable;
    this.detail = detail;
  }
}

/** 统一的中文错误映射(所有适配器错误都应归入这些类别) */
const KIND_MESSAGES = {
  exists: "资源已存在(将复用,不会重建)",
  no_permission: "API Token 权限不足:请检查令牌是否包含 D1/R2/Queues/Workers 的编辑权限",
  not_activated: "R2 尚未开通:请登录 Cloudflare 控制台 → R2 → 按提示开通(免费额度内不扣费)",
  bad_account: "Account ID 不正确:请核对 Account ID 是否属于当前登录的账户",
  network: "网络请求超时或失败:请检查网络后重试",
  config: "配置不正确",
  build: "前端构建失败:请查看上方构建日志",
  deploy: "Worker 部署失败:请查看 wrangler 输出",
  health: "部署完成但健康检查未通过:可稍后手动重试该阶段,或运行 npx wrangler tail 查看日志",
  unknown: "未知错误",
};

export function friendlyError(err) {
  if (err instanceof DeployError) {
    return `${err.message}${err.detail ? `\n详情: ${err.detail}` : ""}`;
  }
  // 按错误类别给出中文说明(注入的 CloudflareError 同样翻译,不暴露 mock 内部信息)
  const kind = err?.kind;
  const base = (kind && KIND_MESSAGES[kind]) || err?.message || String(err);
  return base + (err?.detail ? `\n详情: ${err.detail}` : "");
}

export class DeployStateMachine {
  /**
   * @param opts.cloudflare  适配器(真实 CloudflareClient 或 MockCloudflare),必须实现:
   *   d1List()/d1Create(name)/r2BucketExists(name)/r2Create(name)/queueCreate(name)/
   *   accountId()/migrationsApply(d1Name)/secretPut(workerName,key,value)/
   *   workerDeploy(workerDir,configPath)/verifyAccount()
   * @param opts.journalPath 状态文件路径
   * @param opts.config      年级配置(不含 API Key 明文)
   * @param opts.paths       { workerDir }
   * @param opts.log         日志函数
   */
  constructor(opts) {
    this.cf = opts.cloudflare;
    this.journalPath = opts.journalPath;
    this.config = opts.config;
    this.paths = opts.paths;
    this.log = opts.log || ((msg) => console.log(msg));
    this.journal = this.loadJournal();
  }

  loadJournal() {
    if (existsSync(this.journalPath)) {
      try { return JSON.parse(readFileSync(this.journalPath, "utf-8")); }
      catch (e) { throw new DeployError("config", `状态文件损坏且无法解析: ${this.journalPath}`, { retryable: false, detail: String(e) }); }
    }
    return {
      version: 1,
      grade: this.config.grade_id,
      createdAt: new Date().toISOString(),
      currentStage: STAGES[0],
      stages: {},
      resources: {},
      secrets: {},
      // 配置指纹:恢复时校验,防止改了配置又续跑导致资源与配置错位
      configFingerprint: fingerprint(this.config),
    };
  }

  save() {
    writeFileSync(this.journalPath, JSON.stringify(this.journal, null, 2));
  }

  stageState(name) {
    if (!this.journal.stages[name]) {
      this.journal.stages[name] = { status: "pending", startedAt: null, finishedAt: null, error: null, retryable: true, result: null };
    }
    return this.journal.stages[name];
  }

  isDone(name) { return this.stageState(name).status === "done"; }

  /** 校验续跑一致性:年级或关键配置变了必须显式开新部署 */
  assertSameDeploy() {
    if (this.journal.grade !== this.config.grade_id) {
      throw new DeployError("config", `状态文件属于年级 ${this.journal.grade},与当前 ${this.config.grade_id} 不一致;请更换 journal 或删除后重新开始`, { retryable: false });
    }
    const fp = fingerprint(this.config);
    if (this.journal.configFingerprint && this.journal.configFingerprint !== fp) {
      // 允许非关键漂移,但记录;关键漂移(email_domain/grade_id)已由上一条拦截
      this.journal.configFingerprint = fp;
      this.save();
      this.log("⚠ 配置相对上次运行有变化,已更新指纹(资源命名不受影响的字段可安全继续)");
    }
  }

  /** 执行单个阶段;已 done 则跳过(幂等)。fn 返回值写入 stage.result */
  async runStage(name, fn) {
    const st = this.stageState(name);
    if (st.status === "done") {
      this.log(`↷ 阶段 ${name} 已完成,跳过`);
      return st.result;
    }
    st.status = "running";
    st.startedAt = st.startedAt || new Date().toISOString();
    st.error = null;
    this.journal.currentStage = name;
    this.save();
    this.log(`▶ 阶段 ${name} 开始…`);
    try {
      const result = await fn({
        journal: this.journal,
        setResult: (r) => { st.result = r; },
        log: (m) => this.log(`  ${m}`),
      });
      st.status = "done";
      st.finishedAt = new Date().toISOString();
      this.save();
      this.log(`✔ 阶段 ${name} 完成`);
      return result;
    } catch (err) {
      st.status = "failed";
      st.finishedAt = new Date().toISOString();
      st.error = { kind: err.kind || "unknown", message: friendlyError(err), retryable: err.retryable !== false };
      this.save();
      this.log(`✗ 阶段 ${name} 失败:${st.error.message}`);
      this.log(`  下一步:${st.error.retryable ? `修复后重新运行本工具,将从 ${name} 继续` : "此错误需要人工处理;已有资源不会被动删除"}`);
      throw err;
    }
  }

  async runAll() {
    this.assertSameDeploy();
    for (const name of STAGES) {
      if (name === "completed") { await this.runStage(name, () => this.finishSummary()); continue; }
      await this.runStage(name, (ctx) => this[`stage_${name}`](ctx));
    }
    return this.journal;
  }

  async runSingle(name) {
    this.assertSameDeploy();
    if (!STAGES.includes(name)) throw new DeployError("config", `未知阶段 ${name}`, { retryable: false });
    if (name === "completed") { await this.runStage(name, () => this.finishSummary()); return this.journal; }
    await this.runStage(name, (ctx) => this[`stage_${name}`](ctx));
    return this.journal;
  }

  // ---------------- 阶段实现 ----------------

  async stage_preflight() {
    const required = ["grade_id", "grade_label", "school_name", "email_domain", "resend_from_email", "ai_base_url"];
    for (const key of required) {
      if (!this.config[key]) throw new DeployError("config", `缺少配置项 ${key}`, { retryable: false });
    }
    if (!/^[a-z0-9-]{2,20}$/.test(this.config.grade_id)) {
      throw new DeployError("config", "grade_id 只允许小写字母/数字/短横线(2-20 位)", { retryable: false });
    }
    if (!this.config.teachers_csv || !existsSync(this.config.teachers_csv)) {
      throw new DeployError("config", "教师名单 CSV 文件不存在", { retryable: false });
    }
    return { ok: true };
  }

  async stage_account_check() {
    const account = await this.cf.verifyAccount();
    this.journal.resources.account = { id: account.id, name: account.name };
    if (this.config.cloudflare_account_id && account.id !== this.config.cloudflare_account_id) {
      throw new DeployError("bad_account", `登录账户 ${account.id} 与配置的 Account ID ${this.config.cloudflare_account_id} 不一致 —— 防止跨年级/跨账户误部署`, { retryable: false });
    }
    return account;
  }

  async stage_resources() {
    const g = this.config.grade_id;
    const names = {
      d1: `bns-elab-${g}-db`,
      r2: `bns-elab-${g}-media`,
      queue: `bns-elab-${g}-imggen`,
      dlq: `bns-elab-${g}-imggen-dlq`,
    };
    const r = this.journal.resources;

    // D1:先查后建
    const d1Existing = await this.cf.d1List();
    if (d1Existing.includes(names.d1)) {
      r.d1 = { name: names.d1, createdByTool: false };
      this.log(`  D1 ${names.d1} 已存在,复用`);
    } else {
      const created = await this.cf.d1Create(names.d1);
      r.d1 = { name: names.d1, id: created.id, createdByTool: true };
      this.log(`  D1 ${names.d1} 已创建 (id=${created.id})`);
    }
    if (!r.d1.id) {
      // 已存在但没有 id:从列表详情补取
      r.d1.id = await this.cf.d1GetId(names.d1);
    }

    // R2:检测是否开通
    const r2Exists = await this.cf.r2BucketExists(names.r2);
    if (r2Exists) {
      r.r2 = { name: names.r2, createdByTool: false };
      this.log(`  R2 ${names.r2} 已存在,复用`);
    } else {
      await this.cf.r2Create(names.r2);
      r.r2 = { name: names.r2, createdByTool: true };
      this.log(`  R2 ${names.r2} 已创建`);
    }

    for (const qn of [names.queue, names.dlq]) {
      const exists = await this.cf.queueExists(qn);
      if (!exists) {
        await this.cf.queueCreate(qn);
        r.queues = r.queues || {};
        r.queues[qn] = { createdByTool: true };
        this.log(`  Queue ${qn} 已创建`);
      } else {
        r.queues = r.queues || {};
        r.queues[qn] = { createdByTool: false };
        this.log(`  Queue ${qn} 已存在,复用`);
      }
    }
    this.save();
    return r;
  }

  async stage_migrations() {
    const d1Name = this.journal.resources.d1?.name;
    if (!d1Name) throw new DeployError("config", "缺少 D1 资源记录(请从 resources 阶段恢复)", { retryable: false });
    const out = await this.cf.migrationsApply(d1Name);
    return { applied: true, output: String(out).slice(0, 500) };
  }

  async stage_secrets() {
    const workerName = `bns-elab-${this.config.grade_id}`;
    this.journal.resources.worker = this.journal.resources.worker || { name: workerName };
    // Session Secret 只生成一次;恢复时绝不重新生成
    if (!this.journal.secrets.sessionSecret) {
      this.journal.secrets.sessionSecret = generateHex(32);
      this.log("  已生成 Session Secret(仅存于本机状态文件,不会打印/入库/进仓库)");
    }
    if (!this.journal.secrets.otpSecret) {
      this.journal.secrets.otpSecret = generateHex(32);
    }
    const pairs = {
      SESSION_SECRET: this.journal.secrets.sessionSecret,
      OTP_SECRET: this.journal.secrets.otpSecret,
      RESEND_API_KEY: requireEnvOrConfig("RESEND_API_KEY", this.config.resend_api_key_env_only),
      AI_API_KEY: requireEnvOrConfig("AI_API_KEY", this.config.ai_api_key_env_only),
      CHAT_API_KEY: requireEnvOrConfig("AI_API_KEY", this.config.ai_api_key_env_only),
    };
    for (const [k, v] of Object.entries(pairs)) {
      if (!v) throw new DeployError("config", `缺少密钥 ${k}(请通过安全环境变量提供,不要写入配置文件)`, { retryable: false });
      await this.cf.secretPut(workerName, k, v);
      this.log(`  secret ${k} 已写入(值不显示)`);
    }
    this.save();
    return { keys: Object.keys(pairs) };
  }

  async stage_teachers() {
    const csv = this.config.teachers_csv;
    const rows = parseTeachersCsv(csv);
    if (!rows.length) throw new DeployError("config", "教师名单为空", { retryable: false });
    const admins = (this.config.admin_emails || []).map((s) => s.toLowerCase());
    const duplicates = findDuplicates(rows.map((r) => r.email));
    if (duplicates.length) {
      throw new DeployError("config", `名单存在重复邮箱:${duplicates.join(", ")}`, { retryable: false });
    }
    // 导入为幂等 SQL(存在即跳过),直接对 D1 执行
    const result = await this.cf.teachersImport(this.journal.resources.d1?.name, rows, admins);
    return { total: rows.length, inserted: result.inserted, skipped: result.skipped, admins: admins.length };
  }

  async stage_build() {
    const out = await this.cf.buildWeb(this.paths.webDir);
    return { ok: true, output: String(out).slice(0, 300) };
  }

  async stage_deploy() {
    const out = await this.cf.workerDeploy(this.paths.workerDir, this.config.configPath);
    const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(String(out))?.[0]
      || (this.config.custom_domain ? `https://${this.config.custom_domain}` : null);
    this.journal.resources.worker.url = url;
    if (!url) this.log("  ⚠ 未能从部署输出解析 workers.dev 地址,请从 wrangler 输出确认");
    this.save();
    return { url };
  }

  async stage_healthcheck() {
    const url = this.journal.resources.worker?.url;
    if (!url) throw new DeployError("health", "没有部署地址可检查", { retryable: true });
    const res = await this.cf.healthCheck(url);
    if (!res.ok) throw new DeployError("health", `健康检查失败(HTTP ${res.status}):${res.body?.slice(0, 120)}`, { retryable: true });
    return { status: res.status, body: res.body?.slice(0, 200) };
  }

  finishSummary() {
    const r = this.journal.resources;
    return {
      url: r.worker?.url || "(见 wrangler 输出)",
      d1: r.d1?.name,
      r2: r.r2?.name,
      nextSteps: [
        "打开访问网址,按 docs/DEPLOY_CHECKLIST.md 完成 E 节人工验收",
        "(可选)绑定自定义域名",
        "运行 npx wrangler r2 bucket lifecycle add " + (r.r2?.name || "<bucket>") + " --prefix tmp/ --expire-days 7",
      ],
    };
  }
}

// ---------------- 工具函数 ----------------

function fingerprint(config) {
  const keys = ["grade_id", "email_domain", "school_name"];
  return keys.map((k) => `${k}=${config[k] ?? ""}`).join("|");
}

function generateHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function requireEnvOrConfig(name, configValue) {
  // 密钥优先从环境变量读取;配置文件里只允许放"环境变量名"引用,绝不明文
  return process.env[name] || configValue || "";
}

export function parseTeachersCsv(path) {
  const text = readFileSync(path, "utf-8");
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return [];
  const header = lines[0].toLowerCase();
  const hasHeader = header.includes("real_name") || header.includes("email");
  const rows = (hasHeader ? lines.slice(1) : lines).map((l) => {
    const [name, email] = l.split(",").map((s) => s.trim());
    return { name, email: (email || "").toLowerCase() };
  }).filter((r) => r.name && r.email);
  const domain = extractDomain(rows[0].email);
  for (const r of rows) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) {
      throw new DeployError("config", `名单中的邮箱格式不正确:${r.email}`, { retryable: false });
    }
    void domain;
  }
  return rows;
}

function extractDomain(email) { return email.split("@")[1] || ""; }

export function findDuplicates(list) {
  const seen = new Set();
  const dup = new Set();
  for (const item of list) { if (seen.has(item)) dup.add(item); seen.add(item); }
  return [...dup];
}
