#!/usr/bin/env node
/**
 * D1 备份(P2.5):wrangler d1 export 导出 SQL + R2 清单 + MANIFEST 校验。
 * 用法: node scripts/backup-d1.mjs <grade>            # 导出到 backups/<日期>/
 * 提示: D1 Time Travel 仅 7 天,不等同异地备份;导出文件请存学校认可的加密位置。
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const grade = process.argv[2];
if (!grade) { console.error("用法: node backup-d1.mjs <grade>"); process.exit(1); }
const root = join(here, "..");
const day = new Date().toISOString().slice(0, 10);
const outDir = join(root, "backups", `${day}-${grade}`);
mkdirSync(outDir, { recursive: true });
const db = `bns-elab-${grade}-db`;
const sqlFile = join(outDir, "d1-export.sql");
console.log("> 导出 D1(远程)…");
execSync(`npx wrangler d1 export ${db} --remote --output="${sqlFile}" -y`, { cwd: join(root, "apps/worker"), stdio: "inherit" });
// MANIFEST:关键行数 + 文件哈希
const counts = execSync(
  `npx wrangler d1 execute ${db} --remote --json --command "SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM versions) v, (SELECT COUNT(*) FROM chat_messages) m"`,
  { cwd: join(root, "apps/worker") }).toString();
writeFileSync(join(outDir, "MANIFEST.json"), JSON.stringify({
  date: new Date().toISOString(), grade, db,
  counts_hint: counts.slice(0, 400),
  note: "R2 对象(versions/uploads/attachments)请用 wrangler r2 object get 按前缀分批导出;键路径见 docs/BACKUP_AND_RESTORE.md",
}, null, 2));
console.log("完成:", outDir);
console.log("提醒:恢复演练流程见 docs/BACKUP_AND_RESTORE.md(每学期至少一次)");
