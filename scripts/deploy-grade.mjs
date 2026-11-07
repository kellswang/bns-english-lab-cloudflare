#!/usr/bin/env node
/**
 * P0:一键部署入口(deploy-grade.mjs,取代并整合 new-grade.mjs)。
 *
 * 模式:
 *   node scripts/deploy-grade.mjs                     # 交互式向导(默认预览,最后显式确认才写云端)
 *   node scripts/deploy-grade.mjs --dry-run           # 纯预览,绝不调用任何云端写操作
 *   node scripts/deploy-grade.mjs --config config/grade.json --non-interactive
 *   node scripts/deploy-grade.mjs --resume            # 从状态文件断点续跑
 *   node scripts/deploy-grade.mjs --stage healthcheck # 单独重跑某阶段
 *   CLOUDFLARE_API_TOKEN=... --mock                   # 用 MockCloudflare 跑全流程(测试/演示)
 *
 * 安全红线:
 * - 默认 dry-run:不创建任何资源;
 * - 预览模式绝不执行云端写操作(mock callLog 断言);
 * - 不显示密钥原文;不把名单写进仓库;不收集 Cloudflare 密码/验证码;
 * - 没有任何 delete 操作 —— 物理上无法误删已有资源。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DeployStateMachine, DeployError, friendlyError, STAGES, parseTeachersCsv, findDuplicates } from "./deploy/state-machine.mjs";
import { CloudflareClient } from "./deploy/cloudflare-client.mjs";
import { MockCloudflare } from "./deploy/mock-cloudflare.mjs";
import { Wizard, collectConfig, validators } from "./deploy/wizard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};

const interactive = !has("--non-interactive");
const dryRun = has("--dry-run") || !has("--apply");
const mockMode = has("--mock");
const resume = has("--resume");
const singleStage = opt("--stage");
const configPath = opt("--config") || join(root, "config/grade.json");

function loadConfig() {
  if (!existsSync(configPath)) {
    console.error(`缺少配置文件 ${configPath}(向导会自动生成;非交互模式请先提供)`);
    return null;
  }
  const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
  cfg.configPath = configPath;
  cfg.teachers_csv = cfg.teachers_csv || opt("--teachers-csv") || "";
  return cfg;
}

function preview(cfg) {
  const g = cfg.grade_id;
  console.log("\n===== 部署预览(未执行任何云端操作)=====");
  console.log(`年级:      ${cfg.grade_label} (${g})`);
  console.log(`学校:      ${cfg.school_name}`);
  console.log(`邮箱域名:  ${cfg.email_domain}`);
  console.log(`AI 地址:   ${cfg.ai_base_url}`);
  console.log(`发件地址:  ${cfg.resend_from_email}`);
  console.log(`自定义域:  ${cfg.custom_domain || "(使用 workers.dev)"}`);
  console.log("\n将创建/复用以下资源(先查后建,已存在则复用):");
  console.log(`  Worker:  bns-elab-${g}`);
  console.log(`  D1:      bns-elab-${g}-db`);
  console.log(`  R2:      bns-elab-${g}-media`);
  console.log(`  Queues:  bns-elab-${g}-imggen (+ DLQ)`);
  if (cfg.teachers_csv && existsSync(cfg.teachers_csv)) {
    try {
      const rows = parseTeachersCsv(cfg.teachers_csv);
      const dup = findDuplicates(rows.map((r) => r.email));
      console.log(`\n教师名单: ${rows.length} 人${dup.length ? ` ⚠ 重复邮箱 ${dup.length} 个` : ""}(导入时存在即跳过)`);
      for (const r of rows.slice(0, 3)) console.log(`  · ${r.name} <${r.email}>`);
      if (rows.length > 3) console.log(`  … 共 ${rows.length} 人`);
      if (dup.length) console.log(`  ⚠ 重复: ${dup.join(", ")}`);
    } catch (e) {
      console.log(`  ⚠ 名单解析失败:${e.message}`);
    }
  } else {
    console.log("\n⚠ 未提供教师名单 CSV");
  }
  if (cfg.custom_domain) {
    console.log(`\n⚠ 自定义域名 ${cfg.custom_domain}:将检查其是否已接入当前账户,不会自动修改学校 DNS`);
  }
  console.log("======================================\n");
}

async function main() {
  console.log(`BNS AI English Lab 部署工具 ${dryRun ? "(预览模式 —— 不执行任何云端写操作)" : "(apply 模式)"}`);

  let cfg = loadConfig();
  const wizard = interactive ? new Wizard() : null;

  if (!cfg) {
    if (!interactive) {
      console.error("非交互模式必须提供 --config <文件>");
      process.exit(1);
    }
    cfg = await collectConfig(wizard, {});
    // 写配置(不含任何密钥)
    const { configPath: _cp, ...safe } = cfg;
    writeFileSync(configPath, JSON.stringify(safe, null, 2));
    console.log(`\n已保存配置到 ${configPath}(不含密钥)`);
  }

  preview(cfg);

  if (interactive) {
    const ok = await wizard.confirm("确认以上信息并继续?(预览模式到此为止)", { defaultYes: dryRun });
    if (!ok) { wizard.close(); console.log("已取消,未做任何更改。"); return; }
  }

  // 选择适配器
  const cloudflare = mockMode
    ? new MockCloudflare()
    : new CloudflareClient({
        apiToken: process.env.CLOUDFLARE_API_TOKEN,
        accountId: cfg.cloudflare_account_id || "",
      });

  const journalPath = join(root, `deploy-state-${cfg.grade_id}.json`);
  if (resume && !existsSync(journalPath)) {
    console.error(`没有找到状态文件 ${journalPath},无法恢复;请直接运行(将开始新部署)`);
    process.exit(1);
  }

  const machine = new DeployStateMachine({
    cloudflare,
    journalPath,
    config: cfg,
    paths: { workerDir: join(root, "apps/worker"), webDir: join(root, "apps/web") },
  });

  try {
    if (singleStage) {
      await machine.runSingle(singleStage);
    } else {
      await machine.runAll();
    }
  } catch (err) {
    const isDeploy = err instanceof DeployError;
    console.error(`\n部署中断:${friendlyError(err)}`);
    console.error(`状态已保存到 ${journalPath};修复后可 --resume 继续(已完成阶段自动跳过)。`);
    if (err.kind === "no_permission" && /workflow/i.test(err.detail || "")) {
      console.error("(本错误与部署无关时,请检查令牌权限范围)");
    }
    wizard?.close();
    process.exit(1);
  }

  // 完成摘要
  const j = machine.journal;
  console.log("\n===== 部署完成 =====");
  console.log(`访问地址: ${j.resources.worker?.url || "(见 wrangler 输出)"}`);
  console.log(`D1: ${j.resources.d1?.name}  R2: ${j.resources.r2?.name}`);
  console.log("\n人工验收清单(docs/DEPLOY_CHECKLIST.md E 节):");
  console.log("  [ ] 名单外邮箱请求验证码被拒绝");
  console.log("  [ ] 名单内教师验证码登录成功,显示姓名正确");
  console.log("  [ ] 对话流式回答正常;上传 PDF/DOCX 能被读取");
  console.log("  [ ] 图片生成 V1 → 编辑 V2 → 版本轨正确;下载 PNG 正常");
  console.log("  [ ] 管理页汇总数字正常");
  console.log("  [ ] npx wrangler r2 bucket lifecycle add " + (j.resources.r2?.name || "<bucket>") + " --prefix tmp/ --expire-days 7");
  if (mockMode) {
    const log = cloudflare.callLog;
    const mutating = log.filter((op) => !["verifyAccount", "d1List", "r2BucketExists", "queueExists", "healthCheck", "d1GetId"].includes(op));
    console.log(`\n[mock] 云端写操作调用 ${mutating.length} 次:${[...new Set(mutating)].join(", ")}`);
  }
  wizard?.close();
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
void STAGES; void validators;
