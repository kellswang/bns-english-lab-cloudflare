// E2E 环境准备:生成本地 wrangler.jsonc / .dev.vars / 种子白名单
const fs = require("fs");
const { execSync } = require("child_process");
const root = __dirname + "\\\\..";

let c = fs.readFileSync(root + "/wrangler.jsonc.example", "utf8");
c = c.replaceAll("<grade>", "e2e");
c = c.replace(/"database_id": "[^"]*"/, '"database_id": "local-e2e"');
c = c.replace("<年级显示名,如:四年级>", "E2E年级");
c = c.replace("<学校显示名>", "E2E学校");
c = c.replace("<校内邮箱域名>", "example.edu");
c = c.replace("<发件地址,需在 Resend 完成域名验证>", "noreply@example.edu");
c = c.replace("<图像 API 网关根地址>", "http://127.0.0.1:8791/v1");
c = c.replace("<对话 API 网关根地址>", "http://127.0.0.1:8791/v1");
c = c.replace("<年级负责人邮箱,逗号分隔>", "admin@example.edu");
c = c.replace("<可选:学校出口 IP,逗号分隔>", "");
fs.writeFileSync(root + "/wrangler.jsonc", c);
fs.writeFileSync(root + "/.dev.vars", fs.readFileSync(root + "/.dev.vars.example", "utf8"));
console.log("CONFIG_OK");

// 本地 D1:建表 + 种子教师(E2E 专用占位邮箱)
execSync('npx wrangler d1 execute bns-elab-e2e-db --local --file="../../db/migrations/0001_init.sql"', { cwd: root, stdio: "inherit" });
execSync(`npx wrangler d1 execute bns-elab-e2e-db --local --command "INSERT INTO teacher_invites (id, email, real_name, status, created_at, updated_at) VALUES ('e2e-t1', 'teacher@e2e.test', 'E2E教师', 'active', '2026-01-01', '2026-01-01') ON CONFLICT(email) DO NOTHING; INSERT INTO teacher_invites (id, email, real_name, status, created_at, updated_at) VALUES ('e2e-a1', 'admin@e2e.test', 'E2E管理员', 'active', '2026-01-01', '2026-01-01')"`, { cwd: root, stdio: "inherit" });
console.log("SEED_OK");
