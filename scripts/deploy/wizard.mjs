/**
 * P0.1:中文交互式安装向导(TUI,readline)。
 * 非交互模式(--non-interactive)供 CI / 高级用户直接使用配置文件。
 * 安全:密钥输入不回显、不写日志、不进 journal 明文区;名单不写进仓库。
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const GRADE_RE = /^[a-z0-9-]{2,20}$/;
const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;

export class Wizard {
  constructor() {
    this.rl = readline.createInterface({ input: stdin, output: stdout });
  }
  close() { this.rl.close(); }

  async ask(label, { defaultValue = "", validate = null, secret = false } = {}) {
    for (;;) {
      const suffix = defaultValue ? `(回车 = ${secret ? "****" : defaultValue})` : "";
      let answer;
      if (secret) {
        stdout.write(`${label}${suffix}: `);
        answer = await hiddenInput(this.rl);
        stdout.write("\n");
        if (!answer && defaultValue) answer = defaultValue;
      } else {
        answer = (await this.rl.question(`${label}${suffix}: `)).trim() || defaultValue;
      }
      if (!validate) return answer;
      const err = validate(answer);
      if (!err) return answer;
      console.log(`  ✗ ${err} 请重新输入。`);
    }
  }

  async confirm(label, { defaultYes = false } = {}) {
    const hint = defaultYes ? "[Y/n]" : "[y/N]";
    for (;;) {
      const a = (await this.rl.question(`${label} ${hint}: `)).trim().toLowerCase();
      if (!a) return defaultYes;
      if (a === "y" || a === "yes") return true;
      if (a === "n" || a === "no") return false;
      console.log("  请输入 y 或 n。");
    }
  }
}

/** 密钥隐藏输入:临时置 stdout 为静默(Windows/Unix 通用做法) */
async function hiddenInput(rl) {
  return new Promise((resolve) => {
    const chars = [];
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    const onData = (ch) => {
      const c = ch.toString("utf-8");
      if (c === "\r" || c === "\n") {
        stdin.removeListener("data", onData);
        if (stdin.isTTY) stdin.setRawMode(wasRaw);
        resolve(chars.join(""));
      } else if (c === "\u0003") { // Ctrl+C
        stdin.removeListener("data", onData);
        process.exit(130);
      } else if (c === "\u007f" || c === "\b") {
        chars.pop();
      } else if (c >= " ") {
        chars.push(c);
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
    void rl;
  });
}

// ---------------- 输入校验器 ----------------

export const validators = {
  gradeId: (v) => (GRADE_RE.test(v) ? null : "年级标识只允许 2-20 位小写字母/数字/短横线(将用于所有资源命名)"),
  notEmpty: (label) => (v) => (v && v.trim() ? null : `${label} 不能为空`),
  domain: (v) => (DOMAIN_RE.test(v) ? null : "邮箱域名格式不正确(如 school.edu.cn)"),
  email: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : "邮箱格式不正确"),
  url: (v) => (URL_RE.test(v) ? null : "URL 格式不正确(需 http/https 开头)"),
  csvPath: (v) => {
    const { existsSync } = require("node:fs");
    return v && existsSync(v) ? null : "CSV 文件不存在,请检查路径";
  },
  accountId: (v) => (!v || /^[0-9a-f]{32}$/i.test(v) ? null : "Account ID 是 32 位十六进制字符串"),
  number: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "请输入非负数字"),
};

/** 组装年级配置(交互式收集;密钥仅在最终 secrets 阶段通过环境变量消费) */
export async function collectConfig(wizard, existing = {}) {
  console.log("\n=== BNS AI English Lab 年级部署向导 ===");
  console.log("将为你创建独立的 Cloudflare Worker / D1 / R2 / Queues,互不影响其他年级。\n");

  const cfg = {};
  cfg.grade_label = await wizard.ask("年级显示名称(如 三年级)", { defaultValue: existing.grade_label || "", validate: validators.notEmpty("年级名称") });
  cfg.grade_id = await wizard.ask("年级标识(用于资源命名,小写字母/数字/短横线)", {
    defaultValue: existing.grade_id || "",
    validate: validators.gradeId,
  });
  cfg.school_name = await wizard.ask("学校名称", { defaultValue: existing.school_name || "", validate: validators.notEmpty("学校名称") });
  cfg.email_domain = await wizard.ask("学校邮箱域名(如 school.edu.cn)", { defaultValue: existing.email_domain || "", validate: validators.domain });
  cfg.teachers_csv = await wizard.ask("教师名单 CSV 路径(表头 real_name,email)", {
    defaultValue: existing.teachers_csv || "",
    validate: validators.csvPath("教师名单"),
  });
  cfg.admin_emails = (await wizard.ask("管理员邮箱(从名单中选择,多个用逗号分隔,可回车跳过)", { defaultValue: (existing.admin_emails || []).join(",") })).split(",").map((s) => s.trim()).filter(Boolean);
  cfg.ai_base_url = await wizard.ask("AI API Base URL(如 https://gateway.example.com/v1)", {
    defaultValue: existing.ai_base_url || "",
    validate: validators.url,
  });
  cfg.resend_from_email = await wizard.ask("Resend 已验证的发件地址", {
    defaultValue: existing.resend_from_email || "",
    validate: validators.email,
  });
  cfg.cloudflare_account_id = await wizard.ask("Cloudflare Account ID(32 位十六进制,回车 = 使用当前登录账户)", {
    defaultValue: existing.cloudflare_account_id || "",
    validate: (v) => (!v || validators.accountId(v) === null ? null : validators.accountId(v)),
  });
  cfg.custom_domain = await wizard.ask("自定义域名(可选,回车 = 使用 workers.dev)", { defaultValue: existing.custom_domain || "" });
  cfg.price_per_image_usd = await wizard.ask("图片单价 USD(站内估算用)", { defaultValue: String(existing.price_per_image_usd ?? "0.02"), validate: validators.number });
  cfg.image_daily_limit_per_user = await wizard.ask("每教师每日生成上限", { defaultValue: String(existing.image_daily_limit_per_user ?? 60), validate: validators.number });

  console.log("\n密钥将在此后部署的 secrets 阶段通过隐藏输入或安全环境变量提供:\n" +
    "  CLOUDFLARE_API_TOKEN / RESEND_API_KEY / AI_API_KEY(不显示原文、不写入任何文件)\n");
  return cfg;
}
