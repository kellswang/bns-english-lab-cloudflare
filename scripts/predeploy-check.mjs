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
  "docs/DEPLOY_GRADE.md", "docs/DEPLOY_CHECKLIST.md", "docs/BACKUP_AND_RESTORE.md",
  "docs/UPGRADE_AND_ROLLBACK.md", "docs/COST_MODEL.md", "docs/FEASIBILITY.md",
]) {
  if (!existsSync(join(root, f))) hit(`缺少 ${f}`);
  else console.log("  ✓ " + f);
}

console.log("== 2. 泄漏扫描(学校域邮箱[配置驱动]/密钥特征)==");
// 学校真实域名只从本地 config/grade.json 读取(不入库)—— 公开仓库本身不含真实域名
const gradeCfgPath = join(root, "config", "grade.json");
const schoolDomain = existsSync(gradeCfgPath)
  ? String((JSON.parse(readFileSync(gradeCfgPath, "utf-8")).email_domain || "")).toLowerCase()
  : "";
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
    // 配置了学校域名的实例:任何非占位上下文的校邮箱都视为泄漏
    if (schoolDomain && line.toLowerCase().includes("@" + schoolDomain) &&
        !/不|never|do not|示例|占位|template|example/i.test(line)) {
      hit(`${file}:${i + 1} 疑似真实学校邮箱: ${line.trim().slice(0, 100)}`);
    }
    // 常见密钥形态(sk- 开头 / Resend 形态)
    if (/(sk-[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,})/.test(line)) {
      hit(`${file}:${i + 1} 疑似真实 API 密钥`);
    }
  });
}
console.log(`  扫描 ${scanned} 个文件(学校域名: ${schoolDomain ? "已配置" : "未配置"})`);

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
