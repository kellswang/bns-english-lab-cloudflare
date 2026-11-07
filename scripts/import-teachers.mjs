#!/usr/bin/env node
/**
 * 教师白名单安全导入 —— 对应原 app/cli.py teachers 子命令。
 * 用法:node import-teachers.mjs <csv文件>
 * CSV 格式(config/teachers.template.csv):real_name,email
 *
 * 幂等规则(与原 seed_roster/set_status 一致):
 * - 已存在的邮箱不覆盖姓名与状态(保护手工更正);
 * - --apply 才真正写库;默认 dry-run 打印将发生的变更;
 * - 邮箱域名按本实例 wrangler.jsonc 的 EMAIL_DOMAIN 校验。
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const csvPath = process.argv[2];
const apply = process.argv.includes("--apply");
if (!csvPath) {
  console.error("用法: node import-teachers.mjs <csv> [--apply]");
  process.exit(1);
}

// 读取本实例配置(需要先按 DEPLOY_GRADE.md 复制 wrangler.jsonc)
const cfgFile = join(here, "../apps/worker/wrangler.jsonc");
let cfg;
try {
  cfg = readFileSync(cfgFile, "utf-8");
} catch {
  console.error("未找到 apps/worker/wrangler.jsonc —— 先按 DEPLOY_GRADE.md 完成实例配置");
  process.exit(1);
}
const domain = /"EMAIL_DOMAIN":\s*"([^"]+)"/.exec(cfg)?.[1];
const dbName = /"database_name":\s*"([^"]+)"/.exec(cfg)?.[1];
if (!domain || !dbName) {
  console.error("wrangler.jsonc 缺少 EMAIL_DOMAIN 或 database_name");
  process.exit(1);
}

const rows = readFileSync(csvPath, "utf-8")
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"))
  .slice(1) // 表头
  .map((l) => {
    const [name, email] = l.split(",").map((s) => s.trim());
    return { name, email: (email || "").toLowerCase() };
  })
  .filter((r) => r.name && r.email);

for (const r of rows) {
  if (!r.email.endsWith(`@${domain}`)) {
    console.error(`拒绝(域名不符 ${domain}):${r.email}`);
    process.exit(1);
  }
}

console.log(`解析 ${rows.length} 名教师;域名 @${domain};模式=${apply ? "APPLY(写库)" : "DRY-RUN(仅预览)"}`);

const stmts = rows.map((r) =>
  // 幂等:存在则不动(姓名/状态保留);不存在则插入 active
  `INSERT INTO teacher_invites (id, email, real_name, status, created_at, updated_at) ` +
  `VALUES (lower(hex(randomblob(16))), '${r.email}', '${r.name.replace(/'/g, "''")}', 'active', datetime('now'), datetime('now')) ` +
  `ON CONFLICT(email) DO NOTHING;`);

if (apply) {
  const tmp = join(here, ".import-tmp.sql");
  writeFileSync(tmp, stmts.join("\n"));
  try {
    execSync(`npx wrangler d1 execute ${dbName} --remote --file="${tmp}" -y`, {
      cwd: join(here, "../apps/worker"), stdio: "inherit",
    });
  } finally {
    unlinkSync(tmp);
  }
  console.log("完成。用 `npx wrangler d1 execute " + dbName + " --remote --command \"SELECT email, real_name, status FROM teacher_invites\"` 核对。");
} else {
  console.log("将执行以下 SQL(加 --apply 生效):");
  console.log(stmts.join("\n"));
}
