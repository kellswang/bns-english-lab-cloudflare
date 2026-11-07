#!/usr/bin/env node
/**
 * First-time, opt-in single-grade deployment orchestration.
 * PREVIEW by default. This tool never asks for a password or card information.
 * Cloudflare authentication is read from Wrangler OAuth or scoped environment token.
 * External AI calls and email sending are NOT part of this bootstrap.
 */
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = join(root, "apps/worker");
const cfgPath = join(root, "config/grade.json");
const workerConfig = join(workerDir, "wrangler.jsonc");
const localKeysPath = join(root, "config/deploy.runtime.local"); // *.local is gitignored
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const argAt = args.indexOf("--teachers");
const teachersPath = argAt >= 0 ? args[argAt + 1] : null;
const CUSTOM_DOMAIN_RE = /^(?=.{4,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;

function abort(reason) {
  console.error("部署前检查失败：" + reason);
  process.exit(1);
}
function spawn(command, params, opts = {}) {
  const windows = process.platform === "win32";
  const exe = command === "npx" && windows ? "npx.cmd" : command === "npm" && windows ? "npm.cmd" : command;
  const result = spawnSync(exe, params, {
    cwd: opts.cwd || root,
    encoding: "utf8",
    shell: windows && (command === "npx" || command === "npm"),
    env: process.env,
    stdio: opts.secret ? ["pipe", "pipe", "pipe"] : "inherit",
    input: opts.secret ? opts.input : undefined,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    if (opts.secret) abort("Wrangler Secrets 设置失败；为防止密钥泄漏，不打印原始命令输出。请在本机检查 Cloudflare 授权和 Worker 配置。");
    abort((opts.label || command) + " 执行失败（退出码 " + result.status + "）");
  }
  return result;
}
function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { abort(label + " 不是有效的 JSON，或无法读取。"); }
}
function value(v) { return typeof v === "string" ? v.trim() : ""; }
function checkConfig(cfg) {
  if (!/^[a-z0-9-]{2,20}$/.test(cfg.grade_id || "")) abort("grade_id 必须是 2–20 位小写字母、数字或短横线");
  for (const key of ["grade_label", "school_name", "email_domain", "resend_from_email", "ai_base_url"]) {
    if (!value(cfg[key]) || value(cfg[key]).startsWith("<")) abort("config/grade.json 缺少真实的 " + key);
  }
  if (!Array.isArray(cfg.admin_emails) || !cfg.admin_emails.length) abort("请设置至少一位 admin_emails 管理员");
  const domain = value(cfg.email_domain).toLowerCase();
  if (!CUSTOM_DOMAIN_RE.test(domain)) abort("email_domain 不是合法域名");
  for (const email of cfg.admin_emails) {
    if (typeof email !== "string" || !email.trim().toLowerCase().endsWith("@" + domain)) abort("admin_emails 必须是本年级允许的邮箱域名");
  }
  for (const key of ["ai_base_url", "chat_base_url"]) {
    if (cfg[key]) {
      try { const u = new URL(cfg[key]); if (u.protocol !== "https:") abort(key + " 必须是 HTTPS"); }
      catch { abort(key + " 不是有效 HTTPS URL"); }
    }
  }
  if (cfg.custom_domain && !CUSTOM_DOMAIN_RE.test(cfg.custom_domain)) abort("custom_domain 域名格式不正确");
  if (cfg.custom_domain && !cfg.confirm_zone_connected) abort("使用 custom_domain 时必须确认已将该域名接入本人的 Cloudflare Zone（confirm_zone_connected: true）");
}
function checkTeachers(path, cfg) {
  if (!path || path.startsWith("--")) abort("必须指定 --teachers <位于仓库外的私有名单.csv>");
  const full = resolve(path);
  if (!existsSync(full) || !statSync(full).isFile()) abort("找不到教师 CSV 文件");
  const text = readFileSync(full, "utf8").replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  if (lines.length < 2 || lines[0].toLowerCase().replace(/\s+/g, "") !== "real_name,email") abort("CSV 表头必须为 real_name,email，且至少有一位教师");
  const set = new Set();
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length !== 2) abort("教师 CSV 目前只支持无引号的两列简单格式，姓名不可含逗号");
    const [name, email] = parts.map((s) => s.trim());
    if (!name || !email || !email.toLowerCase().endsWith("@" + cfg.email_domain.toLowerCase())) abort("CSV 中存在姓名或邮箱缺失/域名不符");
    const canonical = email.toLowerCase();
    if (set.has(canonical)) abort("CSV 存在重复邮箱");
    set.add(canonical);
  }
  for (const e of cfg.admin_emails) if (!set.has(e.toLowerCase())) abort("管理员必须存在于教师名单中");
  return { full, count: set.size };
}
if (!existsSync(cfgPath)) abort("请先复制 config/grade.example.json → config/grade.json 并填写实例信息");
const cfg = readJson(cfgPath, "年级配置");
checkConfig(cfg);
const teachers = checkTeachers(teachersPath, cfg);
if (existsSync(workerConfig)) abort("已发现 apps/worker/wrangler.jsonc：这是首次部署工具，为避免覆盖线上实例已停止。后续升级请使用独立升级流程。");
const aiKey = value(process.env.TEAMOROUTER_API_KEY || process.env.AI_API_KEY);
const resendKey = value(process.env.RESEND_API_KEY);
const accountId = value(process.env.CLOUDFLARE_ACCOUNT_ID);
if (process.env.CLOUDFLARE_API_TOKEN && !accountId) abort("使用 API Token 时必须同时提供 CLOUDFLARE_ACCOUNT_ID");
if (!aiKey || !resendKey) abort("请在本机私有环境变量中设置 TEAMOROUTER_API_KEY（或 AI_API_KEY）及 RESEND_API_KEY");
if (cfg.chat_base_url && !value(process.env.CHAT_API_KEY || aiKey)) abort("缺少聊天 API Key");
if (existsSync(localKeysPath)) {
  const prev = readJson(localKeysPath, "私有会话密钥记录");
  if (prev.grade_id !== cfg.grade_id) abort("已有另一个年级的本地会话密钥记录，禁止混用");
  if (prev.cloudflare_account_id && accountId && prev.cloudflare_account_id !== accountId) abort("原密钥记录所属 Cloudflare Account ID 不一致，禁止混用");
}
console.log("年级部署预检查通过");
console.log("年级：" + cfg.grade_id + " · 教师人数：" + teachers.count + " · 管理员人数：" + cfg.admin_emails.length);
console.log("部署目标：" + (cfg.custom_domain || "workers.dev（首次使用默认地址）"));
console.log("密钥只通过进程内环境变量与 Wrangler 标准输入传送，输出中不会显示密钥。");
if (!apply) {
  console.log("\n仅预览。确认已开通 Cloudflare R2 订阅、配置好 Resend 发件域名并拥有 Cloudflare 账号授权后，执行：");
  console.log("node scripts/deploy-grade.mjs --teachers <私有名单.csv> --apply");
  process.exit(0);
}
if (process.env.CLOUDFLARE_API_TOKEN && !/^[a-f0-9]{32}$/i.test(accountId)) abort("CLOUDFLARE_ACCOUNT_ID 格式错误");
console.log("\n[1/6] 安装/核对依赖");
if (!existsSync(join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler"))) {
  spawn("npm", ["ci"], { label: "npm ci" });
}
console.log("[2/6] 检查 Wrangler Cloudflare 认证");
spawn("npx", ["wrangler", "whoami", ...(accountId ? ["--account", accountId] : [])], { cwd: workerDir, label: "wrangler whoami" });
console.log("[3/6] 创建本年级资源并迁移 D1");
spawn(process.execPath, [join(root, "scripts/new-grade.mjs"), "--apply"], { label: "new-grade --apply" });
if (!existsSync(workerConfig)) abort("初始化脚本未生成 Wrangler 配置，停止");
console.log("[4/6] 写入 Worker Secrets");
let localKeys;
if (existsSync(localKeysPath)) {
  localKeys = readJson(localKeysPath, "私有会话密钥记录");
} else {
  localKeys = {
    grade_id: cfg.grade_id,
    cloudflare_account_id: accountId || null,
    SESSION_SECRET: randomBytes(32).toString("hex"),
    OTP_SECRET: randomBytes(32).toString("hex"),
  };
  writeFileSync(localKeysPath, JSON.stringify(localKeys, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log("已生成不受 Git 跟踪的 config/deploy.runtime.local，请在安全位置单独备份；Windows 还需关注文件 ACL");
}
const secrets = {
  SESSION_SECRET: localKeys.SESSION_SECRET,
  OTP_SECRET: localKeys.OTP_SECRET,
  RESEND_API_KEY: resendKey,
  AI_API_KEY: aiKey,
  CHAT_API_KEY: value(process.env.CHAT_API_KEY) || aiKey,
};
spawn("npx", ["wrangler", "secret", "bulk"], {
  cwd: workerDir, label: "secret bulk", secret: true, input: JSON.stringify(secrets),
});
console.log("[5/6] 导入私有教师白名单并构建前端");
spawn(process.execPath, [join(root, "scripts/import-teachers.mjs"), teachers.full, "--apply"], { label: "import-teachers" });
spawn("npm", ["run", "build:web"], { label: "Vue build" });
console.log("[6/6] 部署 Worker 与静态资源");
spawn("npx", ["wrangler", "deploy"], { cwd: workerDir, label: "wrangler deploy" });
console.log("\n基础发布命令执行成功。请核对 Wrangler 输出的网站地址，并手动验收邮件验证码、PDF/DOCX 对话、生图及版本编辑。");
console.log("本工具不调用付费 AI API，也不替用户检查真实发信情况；未完成线上验收前请勿宣称正式可用。");
