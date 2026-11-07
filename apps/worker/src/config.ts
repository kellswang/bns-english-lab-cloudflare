/**
 * 实例配置 —— 对应原 backend/app/config.py 的运行时子集。
 * 每个年级实例通过 wrangler vars + secrets 配置,代码不含任何真实值。
 */
import type { Env } from "./types";

export interface GradeConfig {
  env: "development" | "production";
  gradeId: string;
  gradeLabel: string;
  schoolName: string;
  emailDomain: string;
  emailDevShowCode: boolean;
  sessionCookieName: string;
  sessionDays: number;
  sessionDaysRemember: number;
  aiBaseUrl: string;
  chatBaseUrl: string;
  pricePerImageUsd: number;
  imageDailyLimitPerUser: number;
  imageMaxActivePerUser: number;
  imageMaxActiveGlobal: number;
  maxUploadBytes: number;
  adminEmails: Set<string>;
  exemptIps: Set<string>;
}

export function loadConfig(env: Env): GradeConfig {
  // P6: Demo 模式安全阀 —— 生产环境或配置了真实上游/邮件密钥时强制关闭
  const demoMode = env.DEMO_MODE === "1" && env.APP_ENV !== "production" && !env.RESEND_API_KEY && !env.AI_API_KEY;
  const adminEmails = new Set(
    (env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const exemptIps = new Set(
    (env.EMAIL_RATE_LIMIT_EXEMPT_IPS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  // demoMode 传递给 auth 路由(演示验证码)与 chat/image 路由(mock 上游)
  const config: GradeConfig = {
    env: env.APP_ENV || "production",
    gradeId: env.GRADE_ID || "grade",
    gradeLabel: env.GRADE_LABEL || "英语教研",
    schoolName: env.SCHOOL_NAME || "",
    emailDomain: (env.EMAIL_DOMAIN || "").toLowerCase(),
    emailDevShowCode: env.APP_ENV === "development" || demoMode,
    // Cookie 名含年级 id,保证同负责人多实例浏览器并行登录时不互相覆盖
    sessionCookieName: `bns_lab_session_${env.GRADE_ID || "grade"}`,
    sessionDays: 1,
    sessionDaysRemember: 30,
    aiBaseUrl: env.AI_BASE_URL || "",
    chatBaseUrl: env.CHAT_BASE_URL || env.AI_BASE_URL || "",
    pricePerImageUsd: Number(env.PRICE_PER_IMAGE_USD || "0.02"),
    imageDailyLimitPerUser: Number(env.IMAGE_DAILY_LIMIT_PER_USER || "60"),
    imageMaxActivePerUser: 3,
    imageMaxActiveGlobal: 24,
    maxUploadBytes: 12 * 1024 * 1024,
    adminEmails,
    exemptIps,
  };
  (config as GradeConfig & { demoMode?: boolean }).demoMode = demoMode;
  return config;
}
