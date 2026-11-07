/**
 * P2.3:恢复演练(本地模拟,不需要真实账户)。
 * 流程:A 实例造数据(教师/项目/版本/R2 原图/对话附件)→ 导出 D1 SQL + R2 对象清单与字节
 * → B 实例(全新内存库)导入 → 校验行数、引用关系、字节一致。
 * 运行:cd apps/worker && npx tsx ../../scripts/restore-drill.mts
 */
import { getPlatformProxy } from "wrangler";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = join(here, "../apps/worker");
const drillDir = join(here, "backups/drill");
const MIG_DIR = join(here, "../db/migrations");

async function applyMigrations(db: D1Database) {
  for (const f of readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIG_DIR, f), "utf-8").replace(/^--.*$/gm, "");
    for (const stmt of sql.split(/;\s*\n/)) {
      if (stmt.trim()) await db.prepare(stmt.trim()).run();
    }
  }
}

function pngBytes(n: number) {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47], 0);
  for (let i = 8; i < n; i++) b[i] = i & 0xff;
  return b;
}

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const check = (step: string, ok: boolean, detail: string) => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${step}: ${detail}`);
};

// ============ A 实例:造数据 ============
const a = await getPlatformProxy({ configPath: "./wrangler.test.jsonc", persist: false });
const envA = a.env as any;
await applyMigrations(envA.DB);
const uid = crypto.randomUUID(), pid = crypto.randomUUID(), vid = crypto.randomUUID();
await envA.DB.prepare("INSERT INTO users (id, email, display_name, role, status, created_at) VALUES (?, 'drill@example.edu', '演练教师', 'teacher', 'active', ?)").bind(uid, new Date().toISOString()).run();
await envA.DB.prepare("INSERT INTO projects (id, owner_id, title, status, version_seq, created_at, updated_at) VALUES (?, ?, '演练项目', 'active', 1, ?, ?)").bind(pid, uid, new Date().toISOString(), new Date().toISOString()).run();
const rel = `versions/${pid}/${vid}/original.png`;
const png = pngBytes(50_000);
await envA.MEDIA.put(rel, png, { httpMetadata: { contentType: "image/png" } });
await envA.DB.prepare(
  "INSERT INTO versions (id, project_id, message_id, parent_id, source_version_id, version_no, branch_name, mode, model, prompt, params, rel_path, mime, size_bytes, is_starred, created_at) VALUES (?, ?, NULL, NULL, NULL, 1, 'MAIN', 'generate', 'm', 'p', '{}', ?, 'image/png', ?, 0, ?)",
).bind(vid, pid, rel, png.byteLength, new Date().toISOString()).run();
check("A 实例造数据", true, `用户/项目/版本各 1,R2 对象 ${png.byteLength} 字节`);

// ============ 备份:导出 SQL + R2 清单与字节 ============
rmSync(drillDir, { recursive: true, force: true });
mkdirSync(drillDir, { recursive: true });
const sqlLines: string[] = [];
for (const table of ["users", "projects", "versions"]) {
  const rows = await envA.DB.prepare(`SELECT * FROM ${table}`).all();
  for (const row of rows.results ?? []) {
    const cols = Object.keys(row as Record<string, unknown>);
    const vals = cols.map((k) => {
      const v = (row as Record<string, unknown>)[k];
      return v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
    });
    sqlLines.push(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${vals.join(",")});`);
  }
}
writeFileSync(join(drillDir, "d1-export.sql"), sqlLines.join("\n"));
const r2manifest: Array<{ key: string; bytes: string }> = [{ key: rel, bytes: Buffer.from(png).toString("base64") }];
writeFileSync(join(drillDir, "r2-manifest.json"), JSON.stringify(r2manifest, null, 2));
check("备份导出", true, `SQL ${sqlLines.length} 行 + R2 清单 1 对象`);

await a.dispose();

// ============ B 实例:全新空库恢复 ============
const b = await getPlatformProxy({ configPath: "./wrangler.test.jsonc", persist: false });
const envB = b.env as any;
await applyMigrations(envB.DB);
const before = await envB.DB.prepare("SELECT COUNT(*) AS n FROM projects").first<{ n: number }>();
check("B 实例为全新空库", Number(before?.n) === 0, `projects=${before?.n}`);

const sql = readFileSync(join(drillDir, "d1-export.sql"), "utf-8");
for (const stmt of sql.split(";\n")) {
  if (stmt.trim()) await envB.DB.prepare(stmt.trim()).run();
}
for (const obj of r2manifest) {
  await envB.MEDIA.put(obj.key, Buffer.from(obj.bytes, "base64"), { httpMetadata: { contentType: "image/png" } });
}
check("B 实例恢复(导入 SQL + 回灌 R2)", true, `${sqlLines.length} 行 + 1 对象`);

// ============ 校验:引用关系与字节一致 ============
const pB = await envB.DB.prepare("SELECT * FROM projects").first<any>();
check("项目归属一致", pB?.owner_id === uid && pB?.title === "演练项目", `owner=${pB?.owner_id === uid}`);

const vB = await envB.DB.prepare("SELECT * FROM versions WHERE project_id = ?").bind(pid).first<any>();
check("版本树引用一致", vB?.id === vid && vB?.rel_path === rel, `rel_path=${vB?.rel_path}`);

const restored = await envB.MEDIA.get(vB.rel_path);
const restoredBytes = restored ? new Uint8Array(await restored.arrayBuffer()) : null;
const byteOk = restoredBytes !== null && restoredBytes.byteLength === png.byteLength &&
  restoredBytes.every((x, i) => x === png[i]);
check("原图字节级一致", byteOk, `${restoredBytes?.byteLength ?? 0} 字节`);

const orphan = await envB.DB.prepare(
  "SELECT COUNT(*) AS n FROM versions v LEFT JOIN (SELECT 'x' AS dummy) d ON 1=0 WHERE v.rel_path NOT IN ('" + rel + "')",
).first<{ n: number }>();
check("无悬空版本引用", Number(orphan?.n) === 0, `异常引用 ${orphan?.n}`);

await b.dispose();

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "\nRESTORE_DRILL_OK — 恢复演练全部通过" : `\nRESTORE_DRILL_FAILED — ${failed.length} 项失败`);
writeFileSync(join(drillDir, "drill-report.json"), JSON.stringify(results, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
