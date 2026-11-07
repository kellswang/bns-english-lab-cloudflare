#!/usr/bin/env node
/**
 * 年级实例引导(P0.7/P2.1 加固版)。
 * 用法:
 *   node scripts/new-grade.mjs              # dry-run:仅预览将执行的命令与将生成的配置
 *   node scripts/new-grade.mjs --apply      # 真正创建资源 + 迁移 + 生成本实例配置
 *   node scripts/new-grade.mjs --apply --force  # 覆盖已存在的 wrangler.jsonc
 *
 * 加固点:
 * - database_id 解析失败立即中止(绝不生成 PASTE_DATABASE_ID 占位配置冒充成功);
 * - 完整配置映射(单价/每日限额等全部字段,不再静默忽略);
 * - 幂等:资源已存在跳过;配置已存在需 --force;
 * - R2 临时对象 Lifecycle 兜底命令提示。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cfgPath = join(root, "config/grade.json");
const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const workerDir = join(root, "apps/worker");

if (!existsSync(cfgPath)) {
  console.error("缺少 config/grade.json —— 先复制 grade.example.json 填写");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
const grade = cfg.grade_id;
if (!/^[a-z0-9-]{2,20}$/.test(grade)) {
  console.error("grade_id 只允许小写字母/数字/短横线(2-20 位)");
  process.exit(1);
}
const confPath = join(workerDir, "wrangler.jsonc");
if (apply && existsSync(confPath) && !force) {
  console.error(`apps/worker/wrangler.jsonc 已存在(幂等保护)。确认覆盖请加 --force`);
  process.exit(1);
}

const names = {
  db: `bns-elab-${grade}-db`,
  r2: `bns-elab-${grade}-media`,
  queue: `bns-elab-${grade}-imggen`,
  dlq: `bns-elab-${grade}-imggen-dlq`,
};
const w = (msg) => (apply ? run(msg) : console.log("[dry-run] " + msg));
function run(cmd) {
  console.log("> " + cmd);
  try { return execSync(cmd, { cwd: workerDir, stdio: "pipe" }).toString(); }
  catch (e) {
    const out = String(e.stderr || e.stdout || e.message);
    if (/already exists|已存在/i.test(out)) { console.log("  (已存在,跳过)"); return ""; }
    console.error(out);
    process.exit(1);
  }
}

console.log(`== 年级 [${grade}] 资源初始化 ${apply ? "(APPLY)" : "(dry-run)"} ==`);
const dbOut = apply ? String(run(`npx wrangler d1 create ${names.db}`) || "") : "";
// P0.7:database_id 解析失败 → 立即中止
let dbId = "";
if (apply) {
  dbId = /"database_id"\s*=\s*"([0-9a-f-]{36})"/.exec(dbOut)?.[1]
    ?? /database_id.*?([0-9a-f]{32})/.exec(dbOut)?.[1]
    ?? "";
  if (!dbId) {
    console.error("\n中止:无法从 wrangler d1 create 输出解析 database_id。");
    console.error("请手动执行 `npx wrangler d1 create " + names.db + "` 并把输出的 database_id 告知支持人员,");
    console.error("绝不使用占位配置部署。");
    process.exit(1);
  }
}
w(`npx wrangler r2 bucket create ${names.r2}`);
w(`npx wrangler queues create ${names.queue}`);
w(`npx wrangler queues create ${names.dlq}`);

const tpl = readFileSync(join(root, "apps/worker/wrangler.jsonc.example"), "utf-8");
const map = (s) => s
  .replaceAll("<grade>", grade)
  .replace("<在下方「创建资源」步骤后填入>", apply ? dbId : "PENDING_DRY_RUN")
  .replaceAll("<年级显示名,如:四年级>", cfg.grade_label)
  .replaceAll("<学校显示名>", cfg.school_name)
  .replaceAll("<校内邮箱域名>", cfg.email_domain)
  .replaceAll("<发件地址,需在 Resend 完成域名验证>", cfg.resend_from_email)
  .replaceAll("<图像 API 网关根地址>", cfg.ai_base_url)
  .replaceAll("<对话 API 网关根地址>", cfg.chat_base_url || cfg.ai_base_url)
  .replaceAll("<年级负责人邮箱,逗号分隔>", (cfg.admin_emails || []).join(","))
  .replaceAll("<可选:学校出口 IP,逗号分隔>", (cfg.email_rate_limit_exempt_ips || []).join(","))
  .replace('"PRICE_PER_IMAGE_USD": "0.02"', `"PRICE_PER_IMAGE_USD": "${cfg.price_per_image_usd ?? 0.02}"`)
  .replace('"IMAGE_DAILY_LIMIT_PER_USER": "60"', `"IMAGE_DAILY_LIMIT_PER_USER": "${cfg.image_daily_limit_per_user ?? 60}"`);
const conf = map(tpl);

if (apply) {
  writeFileSync(confPath, conf);
  console.log("已生成 apps/worker/wrangler.jsonc(database_id 已填入)");
  run(`npx wrangler d1 migrations apply ${names.db} --remote`);
  console.log("\n== 剩余手动步骤(详见 docs/DEPLOY_CHECKLIST.md)==");
  console.log("1. 密钥: npx wrangler secret put SESSION_SECRET / OTP_SECRET / RESEND_API_KEY / AI_API_KEY / CHAT_API_KEY");
  console.log("2. 名单: node scripts/import-teachers.mjs <csv> --apply");
  console.log("3. 构建: cd apps/web && npm run build; cd ../worker && npx wrangler deploy");
  console.log("4. R2 临时对象兜底(一次性): npx wrangler r2 bucket lifecycle add " + names.r2 + " --prefix tmp/ --expire-days 7");
} else {
  console.log(conf.split("\n").slice(0, 10).join("\n") + "\n  ...(加 --apply 生成完整配置并执行迁移)");
}
