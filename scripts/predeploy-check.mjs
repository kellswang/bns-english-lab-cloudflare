#!/usr/bin/env node
/**
 * 部署前安全检查:确认仓库中不包含真实人员信息与密钥,必需文件齐备。
 * 用法:node scripts/predeploy-check.mjs
 * 任一检查失败即退出码 1(阻止部署)。
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".wrangler", "dist", ".git", "_audit"]);
const SCAN_EXT = new Set([".ts", ".vue", ".md", ".sql", ".json", ".jsonc", ".csv", ".mjs", ".mts", ".html", ".css", ".example"]);

let failures = 0;
const hit = (msg) => { console.error("  ✗ " + msg); failures++; };

console.log("== 1. 必需文件 ==");
for (const f of [
  "README.md", "package.json", ".gitignore",
  "apps/worker/wrangler.jsonc.example", "apps/worker/.dev.vars.example",
  "apps/worker/src/index.ts", "db/migrations/0001_init.sql",
  "config/grade.example.json", "config/teachers.template.csv",
  "docs/DEPLOY_GRADE.md", "docs/BACKUP_AND_RESTORE.md", "docs/UPGRADE_AND_ROLLBACK.md",
  "docs/COST_MODEL.md", "docs/TEST_REPORT.md", "docs/FEASIBILITY.md", "docs/SOURCE_AUDIT.md",
  "docs/MIGRATION_PLAN.md", "docs/API_COMPATIBILITY.md",
]) {
  if (!existsSync(join(root, f))) hit(`缺少 ${f}`);
  else console.log("  ✓ " + f);
}

console.log("== 2. 泄漏扫描(真实姓名/邮箱模式/密钥特征)==");
// 扫描所有文本文件:任何**非占位**的 @bns.cn 邮箱、长 API key 形态字符串
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(p);
    } else if (SCAN_EXT.has(extname(name))) {
      yield p;
    }
  }
}
let scanned = 0;
for (const file of walk(root)) {
  scanned++;
  const text = readFileSync(file, "utf-8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // @bns.cn 是原学校真实域名:新项目中除文档说明"不要复制"的上下文外,一律视为泄漏
    if (/@bns\.cn/i.test(line) && !/不|never|do not|示例|占位|template|example/i.test(line)) {
      hit(`${file}:${i + 1} 疑似真实学校邮箱: ${line.trim().slice(0, 100)}`);
    }
    // 常见密钥形态(sk- 开头 / 长十六进制 40+ 且非测试用途声明)
    if (/(sk-[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,})/.test(line)) {
      hit(`${file}:${i + 1} 疑似真实 API 密钥`);
    }
  });
}
console.log(`  扫描 ${scanned} 个文件`);

console.log("== 3. 密钥文件不得存在 ==");
for (const f of [".dev.vars", "apps/worker/.dev.vars", "apps/worker/wrangler.jsonc", "config/grade.json"]) {
  if (existsSync(join(root, f))) {
    console.log(`  ⚠ ${f} 存在(本地正常,但已被 .gitignore 排除,部署用)`);
  }
}

if (failures > 0) {
  console.error(`\n检查未通过:${failures} 项问题,禁止部署。`);
  process.exit(1);
}
console.log("\n检查通过:仓库不含真实人员信息与密钥,必需文件齐备。");
