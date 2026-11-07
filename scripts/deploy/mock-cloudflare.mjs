/**
 * P1:Mock Cloudflare —— 与 CloudflareClient 同接口,支持 15 种故障注入。
 * 记录每一次调用(callLog)供测试断言"预览模式绝不执行云端写操作"。
 *
 * 故障注入:mock.failOn(操作名或标签, kind) — 之后第一次匹配的调用抛对应错误;
 * mock.failAlways(tag, kind) — 持续抛出(模拟持续故障)。
 * mock.reset() 清除注入与调用日志(保留资源状态,模拟"重复执行")。
 */
import { CloudflareError } from "./cloudflare-client.mjs";

export class MockCloudflare {
  constructor() {
    this.accounts = [{ id: "acct-mock-0001", name: "Mock Account" }];
    this.d1 = new Map();   // name -> uuid
    this.r2 = new Map();   // name -> true
    this.queues = new Set();
    this.secrets = new Map();  // `${worker}:${key}` -> value
    this.appliedMigrations = new Set();
    this.deployedWorkers = new Map(); // name -> url
    this.healthByWorker = new Map();  // name -> {status, ok, body}
    this.callLog = [];
    this.failRules = [];  // {op, kind, remaining}
    this.teacherRows = new Map(); // d1Name -> Array<row>(模拟已导入名单)
  }

  reset() {
    this.callLog = [];
    this.failRules = [];
  }

  failOn(op, kind, times = 1) { this.failRules.push({ op, kind, remaining: times }); }
  failAlways(op, kind) { this.failRules.push({ op, kind, remaining: Infinity }); }

  maybeFail(op) {
    this.callLog.push(op);
    for (const rule of this.failRules) {
      if ((rule.op === op || rule.op === "*") && rule.remaining > 0) {
        rule.remaining -= 1;
        throw new CloudflareError(rule.kind, `[mock] 注入故障 kind=${rule.kind} @${op}`);
      }
    }
  }

  // ---- account ----
  async verifyAccount() {
    this.maybeFail("verifyAccount");
    return this.accounts[0];
  }

  // ---- D1 ----
  async d1List() { this.maybeFail("d1List"); return [...this.d1.keys()]; }
  async d1GetId(name) { this.maybeFail("d1GetId"); return this.d1.get(name) ?? null; }
  async d1Create(name) {
    this.maybeFail("d1Create");
    if (this.d1.has(name)) throw new CloudflareError("exists", `[mock] D1 ${name} 已存在`);
    const id = crypto.randomUUID();
    this.d1.set(name, id);
    return { id };
  }

  // ---- R2 ----
  async r2BucketExists(name) { this.maybeFail("r2BucketExists"); return this.r2.get(name) === true; }
  async r2Create(name) {
    this.maybeFail("r2Create");
    this.r2.set(name, true);
  }

  // ---- Queues ----
  async queueExists(name) { this.maybeFail("queueExists"); return this.queues.has(name); }
  async queueCreate(name) {
    this.maybeFail("queueCreate");
    this.queues.add(name);
  }

  // ---- migrations(模拟:记录已应用版本;迁移失败场景由 failOn 注入) ----
  async migrationsApply(d1Name) {
    this.maybeFail("migrationsApply");
    if (!this.d1.has(d1Name)) throw new CloudflareError("unknown", `[mock] D1 ${d1Name} 不存在`);
    this.appliedMigrations.add(d1Name);
    return "migrations applied (mock)";
  }

  // ---- secrets ----
  async secretPut(workerName, key, value) {
    this.maybeFail(`secretPut:${key}`);
    if (!value) throw new CloudflareError("config", `[mock] secret ${key} 值为空`);
    this.secrets.set(`${workerName}:${key}`, value);
    return { ok: true };
  }
  secretGet(workerName, key) { return this.secrets.get(`${workerName}:${key}`) ?? null; }

  // ---- teachers(模拟 D1 执行) ----
  async teachersImport(d1Name, rows) {
    this.maybeFail("teachersImport");
    if (!this.d1.has(d1Name)) throw new CloudflareError("unknown", `[mock] D1 ${d1Name} 不存在`);
    const existing = this.teacherRows.get(d1Name) || new Map();
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      if (existing.has(r.email)) skipped++;
      else { existing.set(r.email, r); inserted++; }
    }
    this.teacherRows.set(d1Name, existing);
    return { inserted, skipped };
  }
  teacherCount(d1Name) { return (this.teacherRows.get(d1Name) || new Map()).size; }

  // ---- build / deploy / health ----
  async buildWeb() {
    this.maybeFail("buildWeb");
    return "built (mock)";
  }
  async workerDeploy(workerDir, configPath) {
    this.maybeFail("workerDeploy");
    const name = (configPath || "").includes("citest") ? "bns-elab-citest" : "bns-elab-mock";
    const url = `https://${name}.mock.workers.dev`;
    this.deployedWorkers.set(name, url);
    return `Deployed ${name} triggers (mock)\nhttps://${name}.mock.workers.dev`;
  }
  setHealth(workerName, status, ok, body = "") { this.healthByWorker.set(workerName, { status, ok, body }); }
  async healthCheck(url) {
    this.maybeFail("healthCheck");
    const name = /https:\/\/([a-z0-9-]+)\./.exec(url)?.[1] || "";
    const preset = this.healthByWorker.get(name);
    if (preset) return preset;
    return { status: 200, ok: true, body: '{"ok":true}' };
  }
}
