#!/usr/bin/env node
/**
 * P5:教师与管理员日常维护工具(远程 D1,操作留审计)。
 *
 * 用法(node scripts/teachers.mjs <命令> [参数] [--apply]):
 *   list                        列出白名单与状态
 *   add <姓名> <邮箱>           增加教师(域名必须匹配)
 *   rename <邮箱> <新姓名>      修改显示姓名
 *   disable <邮箱>              停用(已有会话立即失效)
 *   enable <邮箱>               重新启用
 *   set-admin <邮箱>            标记管理员(需同时在该用户行上提升 role)
 *   unset-admin <邮箱>          取消管理员
 *   export                      导出当前名单为 CSV(stdout,不落仓库)
 *   audit [n]                   查看最近 n 条审计日志(默认 20)
 *
 * 安全:
 * - 默认 dry-run,加 --apply 才写库;
 * - 停用/启用同步 users.status(即时撤销已有会话);
 * - 禁止撤销最后一位管理员(set-admin/unset-admin 检查);
 * - 所有 --apply 操作写入 audit_logs(actors = 执行者邮箱,来自 --actor 或 config 管理员)。
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const apply = process.argv.includes("--apply");
const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "--actor=admin@cli").split("=")[1];

function loadConf() {
  const p = join(root, "apps/worker/wrangler.jsonc");
  if (!existsSync(p)) { console.error("未找到 apps/worker/wrangler.jsonc"); process.exit(1); }
  const cfg = readFileSync(p, "utf-8");
  const dbName = /"database_name":\s*"([^"]+)"/.exec(cfg)?.[1];
  const domain = /"EMAIL_DOMAIN":\s*"([^"]+)"/.exec(cfg)?.[1];
  if (!dbName || !domain) { console.error("配置缺少 database_name 或 EMAIL_DOMAIN"); process.exit(1); }
  return { dbName, domain };
}
const { dbName, domain } = loadConf();

const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== "--apply");
const email = rest.find((r) => r.includes("@"))?.toLowerCase() || "";
const nameArg = rest.find((r) => !r.includes("@"));

function d1sql(sql) {
  if (!apply) { console.log(`[dry-run] ${sql}`); return; }
  const { mkdtempSync } = require("node:fs");
  const { join: jp } = require("node:path");
  const { tmpdir } = require("node:os");
  const tmp = jp(mkdtempSync(jp(tmpdir(), "t-")), "q.sql");
  writeFileSync(tmp, sql.endsWith(";") ? sql : sql + ";");
  try {
    const out = execSync(`npx wrangler d1 execute ${dbName} --remote --file="${tmp}" --json`, { cwd: join(root, "apps/worker"), stdio: "pipe" }).toString();
    try { return JSON.parse(out)[0]?.results; } catch { return out; }
  } finally {
    unlinkSync(tmp);
  }
}
function audit(action, detail) {
  if (!apply) return;
  d1sql(`INSERT INTO audit_logs (id, actor_email, action, entity_id, detail, ip, created_at) VALUES (lower(hex(randomblob(16))), '${actor.replace(/'/g, "''")}', '${action}', NULL, '${String(detail).replace(/'/g, "''")}', NULL, datetime('now'))`);
}
function requireEmail() { if (!email) { console.error("请提供邮箱参数"); process.exit(1); } }

switch (cmd) {
  case "list": {
    const rows = d1sql("SELECT email, real_name, status, user_id FROM teacher_invites ORDER BY email") || [];
    for (const r of rows) console.log(`${r.status.padEnd(8)} ${r.email.padEnd(28)} ${r.real_name}${r.user_id ? " (已开通)" : ""}`);
    console.log(`共 ${rows.length} 人`);
    break;
  }
  case "add": {
    const name = nameArg;
    if (!name || !email) { console.error("用法: add <姓名> <邮箱>"); process.exit(1); }
    if (!email.endsWith("@" + domain)) { console.error(`邮箱必须是 @${domain} 域名`); process.exit(1); }
    d1sql(`INSERT INTO teacher_invites (id, email, real_name, status, created_at, updated_at) VALUES (lower(hex(randomblob(16))), '${email}', '${name.replace(/'/g, "''")}', 'active', datetime('now'), datetime('now')) ON CONFLICT(email) DO NOTHING`);
    audit("teacher.add", `${email} ${name}`);
    console.log(apply ? `已添加 ${name} <${email}>` : "(dry-run)");
    break;
  }
  case "rename": {
    requireEmail();
    if (!nameArg) { console.error("用法: rename <邮箱> <新姓名>"); process.exit(1); }
    d1sql(`UPDATE teacher_invites SET real_name = '${nameArg.replace(/'/g, "''")}', updated_at = datetime('now') WHERE email = '${email}'`);
    d1sql(`UPDATE users SET display_name = '${nameArg.replace(/'/g, "''")}' WHERE email = '${email}'`);
    audit("teacher.rename", `${email} → ${nameArg}`);
    console.log(apply ? "已改名(白名单与用户显示名同步)" : "(dry-run)");
    break;
  }
  case "disable": {
    requireEmail();
    d1sql(`UPDATE teacher_invites SET status = 'disabled', updated_at = datetime('now') WHERE email = '${email}'`);
    d1sql(`UPDATE users SET status = 'suspended' WHERE email = '${email}'`);
    audit("teacher.disable", email);
    console.log(apply ? `已停用 ${email}(已有会话立即失效)` : "(dry-run)");
    break;
  }
  case "enable": {
    requireEmail();
    d1sql(`UPDATE teacher_invites SET status = 'active', updated_at = datetime('now') WHERE email = '${email}'`);
    d1sql(`UPDATE users SET status = 'active' WHERE email = '${email}' AND status = 'suspended'`);
    audit("teacher.enable", email);
    console.log(apply ? `已启用 ${email}` : "(dry-run)");
    break;
  }
  case "set-admin": {
    requireEmail();
    // 管理员来自 ADMIN_EMAILS(env)+ users.role;改 role 前提示此配置语义
    console.log("注意: 管理员判定 = ADMIN_EMAILS 配置 ∪ users.role='admin';建议同步更新 wrangler.jsonc 的 ADMIN_EMAILS 后重新部署。");
    d1sql(`UPDATE users SET role = 'admin' WHERE email = '${email}'`);
    audit("teacher.set_admin", email);
    console.log(apply ? `已将 ${email} 设为管理员` : "(dry-run)");
    break;
  }
  case "unset-admin": {
    requireEmail();
    const admins = d1sql("SELECT email FROM users WHERE role = 'admin' AND status = 'active'") || [];
    const list = Array.isArray(admins) ? admins : [];
    if (list.length <= 1 && list.some((u) => u.email === email)) {
      console.error("拒绝:这是最后一位管理员。请先设置另一位管理员。");
      process.exit(1);
    }
    d1sql(`UPDATE users SET role = 'teacher' WHERE email = '${email}'`);
    audit("teacher.unset_admin", email);
    console.log(apply ? `已取消 ${email} 的管理员` : "(dry-run)");
    break;
  }
  case "export": {
    const rows = d1sql("SELECT real_name, email, status FROM teacher_invites ORDER BY email") || [];
    console.log("real_name,email,status");
    for (const r of rows) console.log(`${r.real_name},${r.email},${r.status}`);
    console.error(`(以上为 ${rows.length} 条导出;请勿保存到公开位置)`);
    break;
  }
  case "audit": {
    const n = Number(nameArg || 20);
    const rows = d1sql(`SELECT created_at, actor_email, action, detail FROM audit_logs ORDER BY created_at DESC LIMIT ${n}`) || [];
    for (const r of rows) console.log(`${r.created_at} [${r.actor_email ?? "system"}] ${r.action} ${r.detail ?? ""}`);
    break;
  }
  case "dupcheck": {
    const rows = d1sql("SELECT email, COUNT(*) n FROM teacher_invites GROUP BY email HAVING n > 1") || [];
    console.log(rows.length ? `发现重复: ${JSON.stringify(rows)}` : "无重复邮箱");
    break;
  }
  default:
    console.log("命令: list | add | rename | disable | enable | set-admin | unset-admin | export | audit | dupcheck(加 --apply 执行)");
}
