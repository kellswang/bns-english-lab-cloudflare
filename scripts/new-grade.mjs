#!/usr/bin/env node
/**
 * 年级实例引导(P2.4):读取 config/grade.json,自动创建资源并生成本实例 wrangler.jsonc。
 * 用法:
 *   1. cp config/grade.example.json config/grade.json 并填写
 *   2. node scripts/new-grade.mjs            # 预览将执行的命令
 *   3. node scripts/new-grade.mjs --apply    # 真正创建资源 + 迁移 + 生成配置
 * 幂等:已存在的资源会提示并跳过;绝不触碰其他年级或原项目。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cfgPath = join(root, "config/grade.json");
const apply = process.argv.includes("--apply");

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
const names = {
  worker: `bns-elab-${grade}`,
  db: `bns-elab-${grade}-db`,
  r2: `bns-elab-${grade}-media`,
  queue: `bns-elab-${grade}-imggen`,
  dlq: `bns-elab-${grade}-imggen-dlq`,
};
const w = (msg) => (apply ? run(msg) : console.log("[dry-run] " + msg));
function run(cmd) {
  console.log("> " + cmd);
  try { return execSync(cmd, { cwd: join(root, "apps/worker"), stdio: "pipe" }).toString(); }
  catch (e) {
    const out = String(e.stderr || e.stdout || e.message);
    if (/already exists|已存在/i.test(out)) { console.log("  (已存在,跳过)"); return ""; }
    console.error(out); process.exit(1);
  }
}

console.log(`== 年级 [${grade}] 资源初始化 ${apply ? "(APPLY)" : "(预览)"} ==`);
const dbOut = w(`npx wrangler d1 create ${names.db}`) || "";
const dbId = /"database_id"\s*=\s*"([0-9a-f]+)"/.exec(String(dbOut))?.[1]
  ?? /database_id.*?([0-9a-f]{32})/.exec(String(dbOut))?.[1] ?? "PASTE_DATABASE_ID";
w(`npx wrangler r2 bucket create ${names.r2}`);
w(`npx wrangler queues create ${names.queue}`);
w(`npx wrangler queues create ${names.dlq}`);

// 生成本实例 wrangler.jsonc(已在 .gitignore)
const tpl = readFileSync(join(root, "apps/worker/wrangler.jsonc.example"), "utf-8");
const conf = tpl
  .replaceAll("<grade>", grade)
  .replaceAll("bns-elab-<grade>", names.worker.replace(`bns-elab-${grade}`, `bns-elab-${grade}`))
  .replace("<在下方「创建资源」步骤后填入>", dbId)
  .replaceAll("<年级显示名,如:四年级>", cfg.grade_label)
  .replaceAll("<学校显示名>", cfg.school_name)
  .replaceAll("<校内邮箱域名>", cfg.email_domain)
  .replaceAll("<发件地址,需在 Resend 完成域名验证>", cfg.resend_from_email)
  .replaceAll("<图像 API 网关根地址>", cfg.ai_base_url)
  .replaceAll("<对话 API 网关根地址>", cfg.chat_base_url || cfg.ai_base_url)
  .replaceAll("<年级负责人邮箱,逗号分隔>", (cfg.admin_emails || []).join(","))
  .replaceAll("<可选:学校出口 IP,逗号分隔>", (cfg.email_rate_limit_exempt_ips || []).join(","));
if (apply) {
  writeFileSync(join(root, "apps/worker/wrangler.jsonc"), conf);
  console.log("已生成 apps/worker/wrangler.jsonc");
  run(`npx wrangler d1 migrations apply ${names.db} --remote`);
  console.log("\n下一步(手动):");
  console.log("  npx wrangler secret put SESSION_SECRET   # 值: openssl rand -hex 32");
  console.log("  npx wrangler secret put OTP_SECRET / RESEND_API_KEY / AI_API_KEY / CHAT_API_KEY");
  console.log("  cd ../web && npm run build && cd ../worker && npx wrangler deploy");
  console.log("  node ../../scripts/import-teachers.mjs <名单.csv> --apply");
} else {
  console.log(conf.split("\n").slice(0, 8).join("\n") + "\n  ...(加 --apply 生成完整配置)");
}
