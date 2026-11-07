/** Worker 全局绑定与共享类型。 */

export interface Env {
  // Cloudflare 资源绑定(名称在 wrangler.jsonc 中定义)
  DB: D1Database;
  MEDIA: R2Bucket;
  GEN: Queue<GenerationMessage>;
  ASSETS: Fetcher;

  // Secrets(每年级实例独立配置;绝不入库、绝不入仓库)
  SESSION_SECRET: string;
  OTP_SECRET: string;
  RESEND_API_KEY: string;
  AI_API_KEY: string;
  CHAT_API_KEY: string;

  // Vars(wrangler.jsonc [vars];非敏感实例配置)
  APP_ENV: "development" | "production";
  GRADE_ID: string;
  GRADE_LABEL: string;
  SCHOOL_NAME: string;
  EMAIL_DOMAIN: string;
  RESEND_FROM_EMAIL: string;
  AI_BASE_URL: string;
  CHAT_BASE_URL: string;
  PRICE_PER_IMAGE_USD: string;
  IMAGE_DAILY_LIMIT_PER_USER: string;
  ADMIN_EMAILS: string;
  EMAIL_RATE_LIMIT_EXEMPT_IPS: string;
  /** P6: 演示模式(仅 development 允许)—— 固定演示账号、mock 验证码与 AI,绝不能在生产开启 */
  DEMO_MODE: string;
}

export interface GenerationMessage {
  job_id: string;
}

/** 统一 API 错误体:原项目 FastAPI {"detail": ...} 的超集,保持 detail 字段兼容 */
export interface ApiError {
  detail: string | { reason?: string; message?: string; [k: string]: unknown };
}
