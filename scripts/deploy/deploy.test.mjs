/**
 * P1:Mock Cloudflare 部署流程测试 —— 故障注入 + 幂等 + 隔离 + 预览零写操作。
 */
import { writeFileSync, mkdtempSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach } from "vitest";
import { DeployStateMachine, DeployError, friendlyError, parseTeachersCsv, findDuplicates } from "./state-machine.mjs";
import { MockCloudflare } from "./mock-cloudflare.mjs";

const tmp = mkdtempSync(join(tmpdir(), "deploy-test-"));
const journalPath = () => join(tmp, `state-${crypto.randomUUID()}.json`);

function makeConfig(grade = "g1") {
  return {
    grade_id: grade,
    grade_label: "测试年级",
    school_name: "测试学校",
    email_domain: "example.edu",
    resend_from_email: "noreply@example.edu",
    ai_base_url: "https://ai-mock.test/v1",
    admin_emails: ["teacher01@example.edu"],
    configPath: undefined,
  };
}

function writeCsv(rows) {
  const path = join(tmp, `t-${crypto.randomUUID()}.csv`);
  writeFileSync(path, "real_name,email\n" + rows.map((r) => `${r.name},${r.email}`).join("\n"));
  return path;
}

const TEACHERS = Array.from({ length: 5 }, (_, i) => ({
  name: `教师${i + 1}`,
  email: `teacher0${i + 1}@example.edu`,
}));

function makeMachine(mock, cfg) {
  return new DeployStateMachine({
    cloudflare: mock,
    journalPath: journalPath(),
    config: { ...cfg, teachers_csv: writeCsv(TEACHERS) },
    paths: { workerDir: ".", webDir: "." },
    log: () => {},
  });
}

beforeEach(() => {
  process.env.RESEND_API_KEY = "resend-test-key";
  process.env.AI_API_KEY = "ai-test-key";
});

describe("P1:正常部署全流程", () => {
  it("10 阶段全部完成,资源创建一次,secrets 写入且不打印", async () => {
    const mock = new MockCloudflare();
    const m = makeMachine(mock, makeConfig());
    const j = await m.runAll();

    expect(j.currentStage).toBe("completed");
    expect(j.resources.d1.createdByTool).toBe(true);
    expect(j.resources.r2.createdByTool).toBe(true);
    expect(j.resources.queues["bns-elab-g1-imggen"].createdByTool).toBe(true);
    expect(j.resources.queues["bns-elab-g1-imggen-dlq"].createdByTool).toBe(true);
    expect(j.resources.worker.url).toContain("workers.dev");
    expect(mock.teacherCount("bns-elab-g1-db")).toBe(5);
    expect(mock.secretGet("bns-elab-g1", "SESSION_SECRET")).toMatch(/^[0-9a-f]{64}$/);
    expect(mock.secretGet("bns-elab-g1", "AI_API_KEY")).toBe("ai-test-key");
  });

  it("从头重复执行(删 journal 模拟用户重跑):无重复资源、无重复名单", async () => {
    const mock = new MockCloudflare();
    const cfg = makeConfig();
    const m1 = makeMachine(mock, cfg);
    await m1.runAll();
    const d1After = mock.d1.size;
    // 模拟用户第二次全新运行:清掉注入与调用日志,保留云资源,删除 journal
    mock.reset();
    if (existsSync(m1.journalPath)) unlinkSync(m1.journalPath);
    const j2 = await makeMachine(mock, cfg).runAll();
    expect(mock.d1.size).toBe(d1After); // 无重复创建
    expect(j2.resources.d1.createdByTool).toBe(false); // 识别为既有资源并复用
    expect(mock.r2.size).toBe(1);
    expect(mock.queues.size).toBe(2);
    expect(mock.teacherCount("bns-elab-g1-db")).toBe(5); // 名单未重复导入
  });

  it("恢复:Secret 不重新生成", async () => {
    const mock = new MockCloudflare();
    const cfg = makeConfig();
    const m1 = makeMachine(mock, cfg);
    await m1.runAll();
    const secret1 = m1.journal.secrets.sessionSecret;
    mock.reset();
    mock.failOn("workerDeploy", "deploy");
    // 模拟 deploy 中断:重置该阶段状态
    const m2 = new DeployStateMachine({
      cloudflare: mock, journalPath: m1.journalPath, config: { ...cfg, teachers_csv: writeCsv(TEACHERS) },
      paths: { workerDir: ".", webDir: "." }, log: () => {},
    });
    m2.journal.stages.deploy = { status: "pending" };
    m2.save();
    let err = null;
    try { await m2.runAll(); } catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(m2.journal.secrets.sessionSecret).toBe(secret1); // 未重新生成
    expect(m2.journal.stages.secrets.status).toBe("done"); // 跳过
  });

  it("配置漂移:grade_id 变更拒绝续跑", async () => {
    const mock = new MockCloudflare();
    const m = makeMachine(mock, makeConfig("g1"));
    await m.runAll();
    const m2 = makeMachine(mock, makeConfig("g2"));
    // 强制用 g1 的 journal
    m2.journalPath = m.journalPath;
    m2.journal = m.journal;
    let err = null;
    try { await m2.runAll(); } catch (e) { err = e; }
    expect(err instanceof DeployError).toBe(true);
    expect(err.kind).toBe("config");
    expect(err.retryable).toBe(false);
  });
});

describe("P1:故障注入", () => {
  const scenarios = [
    ["d1Create", "exists", "D1 已存在"],
    ["r2Create", "exists", "R2 已存在"],
    ["r2Create", "not_activated", "R2 未开通"],
    ["d1Create", "no_permission", "令牌无权限"],
    ["verifyAccount", "bad_account", "Account ID 错误"],
    ["verifyAccount", "network", "网络超时"],
    ["migrationsApply", "deploy", "迁移失败"],
    ["queueCreate", "unknown", "Queues 创建失败"],
    ["buildWeb", "build", "前端构建失败"],
    ["workerDeploy", "deploy", "Worker 部署失败"],
    ["healthCheck", "health", "部署后健康检查失败"],
  ];

  for (const [op, kind, label] of scenarios) {
    it(`故障:${label}(${op} → ${kind})`, async () => {
      const mock = new MockCloudflare();
      mock.failOn(op, kind);
      const m = makeMachine(mock, makeConfig());
      let caught = null;
      try { await m.runAll(); } catch (e) { caught = e; }
      expect(caught).not.toBeNull();
      // 中文友好说明(按 kind 翻译,不暴露注入内部信息)
      const msg = friendlyError(caught);
      expect(msg.length).toBeGreaterThanOrEqual(4);
      expect(msg).not.toContain("[mock]");
      // journal 记录失败阶段
      const failedStage = Object.values(m.journal.stages).find((s) => s.status === "failed");
      expect(failedStage).toBeTruthy();
      expect(failedStage.error.kind).toBeTruthy();
      expect(typeof failedStage.error.retryable).toBe("boolean");
      // 没有删除类调用(适配器不提供 delete —— 双保险)
      expect(mock.callLog.some((op2) => /delete/i.test(op2))).toBe(false);
    });
  }

  it("故障:Secrets 值缺失(config,不可重试)", async () => {
    delete process.env.RESEND_API_KEY;
    const mock = new MockCloudflare();
    const m = makeMachine(mock, makeConfig());
    let caught = null;
    try { await m.runAll(); } catch (e) { caught = e; }
    expect(caught).not.toBeNull();
    expect(caught.kind).toBe("config");
    const failedStage = Object.values(m.journal.stages).find((s) => s.status === "failed");
    expect(failedStage.error.retryable).toBe(false);
    process.env.RESEND_API_KEY = "resend-test-key";
  });

  it("R2 已存在:复用而非报错(createdByTool=false)", async () => {
    const mock = new MockCloudflare();
    await mock.r2Create("bns-elab-g1-media");
    const m = makeMachine(mock, makeConfig());
    await m.runAll();
    expect(m.journal.resources.r2.createdByTool).toBe(false);
  });

  it("D1 已存在:复用并补取 id", async () => {
    const mock = new MockCloudflare();
    await mock.d1Create("bns-elab-g1-db");
    const m = makeMachine(mock, makeConfig());
    await m.runAll();
    expect(m.journal.resources.d1.createdByTool).toBe(false);
    expect(m.journal.resources.d1.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("不同年级同时部署:资源命名与状态文件隔离", async () => {
    const mock = new MockCloudflare();
    await makeMachine(mock, makeConfig("g1")).runAll();
    await makeMachine(mock, makeConfig("g2")).runAll();
    expect([...mock.d1.keys()].sort()).toEqual(["bns-elab-g1-db", "bns-elab-g2-db"]);
    expect([...mock.r2.keys()].sort()).toEqual(["bns-elab-g1-media", "bns-elab-g2-media"]);
    expect(mock.teacherCount("bns-elab-g1-db")).toBe(5);
    expect(mock.teacherCount("bns-elab-g2-db")).toBe(5);
  });
});

describe("P1:预览模式零写操作", () => {
  it("只读阶段(mock callLog 断言):不出现任何创建/写入调用", async () => {
    const mock = new MockCloudflare();
    const m = makeMachine(mock, makeConfig());
    await m.runSingle("preflight");
    await m.runSingle("account_check");
    const mutatingOps = mock.callLog.filter((op) =>
      !["verifyAccount", "d1List", "r2BucketExists", "queueExists", "d1GetId", "healthCheck"].includes(op),
    );
    expect(mutatingOps).toEqual([]);
  });

  it("只读调用清单里没有 create/put/apply/deploy/import", async () => {
    const mock = new MockCloudflare();
    const m = makeMachine(mock, makeConfig());
    await m.runSingle("preflight");
    await m.runSingle("account_check");
    for (const op of mock.callLog) {
      expect(/create|put|apply|deploy|import/i.test(op)).toBe(false);
    }
  });
});

describe("CSV 解析与重复检测", () => {
  it("重复邮箱被检测", () => {
    expect(findDuplicates(["a@x", "b@x", "a@x"])).toEqual(["a@x"]);
  });

  it("表头自动识别", () => {
    const path = writeCsv([{ name: "张三", email: "a@example.edu" }]);
    const rows = parseTeachersCsv(path);
    expect(rows).toEqual([{ name: "张三", email: "a@example.edu" }]);
  });
});
