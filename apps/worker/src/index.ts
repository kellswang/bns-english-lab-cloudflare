/**
 * Worker 入口:fetch(API + 静态资源回退)+ queue(图片任务)+ scheduled(Cron)。
 *
 * - /api/* 进 Worker;其余静态资源由 Cloudflare Static Assets 直出
 *   (run_worker_first 仅 /api/*,静态请求不计费、不占 CPU)。
 * - 安全头与跨站 Origin 检查对应原 main.py security_layer。
 * - Cron:每 15 分钟费用核对;每 5 分钟任务巡检;北京时间 04:30 清理。
 */
import { Hono } from "hono";
import type { Env, GenerationMessage } from "./types";
import { errorResponse } from "./utils/http";
import { authRoutes } from "./routes/auth";
import { generationRoutes } from "./routes/generation";
import { projectRoutes } from "./routes/projects";
import { fileRoutes } from "./routes/files";
import { usageRoutes, adminRoutes } from "./routes/usageAdmin";
import { chatRoutes } from "./routes/chat";
import { handleQueueBatch } from "./queues/imageConsumer";
import { reconcilePending } from "./cron/reconcile";
import { sweepQueued, recoverStuckJobs, cleanupExpired } from "./cron/sweep";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => errorResponse(err));

// ---- 健康检查(与原 /api/v1/health 语义一致:DB 可用才算健康) ----
app.get("/api/v1/health", async (c) => {
  let dbOk = true;
  try {
    await c.env.DB.prepare("SELECT 1").first();
  } catch {
    dbOk = false;
  }
  const payload = {
    ok: dbOk,
    app: `${c.env.GRADE_LABEL || ""}英语教研平台`,
    env: c.env.APP_ENV,
    mail: c.env.RESEND_API_KEY ? "resend" : "mock",
    ai_configured: Boolean(c.env.AI_API_KEY && c.env.AI_BASE_URL),
    chat: true,
    checks: { db: dbOk },
  };
  return c.json(payload, dbOk ? 200 : 503);
});

app.get("/api/v1/health/live", (c) => c.json({ ok: true, app: c.env.GRADE_LABEL || "bns-lab", env: c.env.APP_ENV }));

app.route("/api/v1", authRoutes);
app.route("/api/v1", generationRoutes);
app.route("/api/v1", projectRoutes);
app.route("/api/v1", fileRoutes);
app.route("/api/v1", usageRoutes);
app.route("/api/v1", adminRoutes);
app.route("/api/v1", chatRoutes);

// 未注册 / 已下线的 API 一律 404(与原 main.api_not_found 一致)
app.all("/api/*", (c) => c.json({ detail: "Not Found" }, 404));

// ---- 安全层:Origin 校验(写方法)+ 安全响应头 ----
app.use("*", async (c, next) => {
  const method = c.req.method;
  if (["POST", "PATCH", "DELETE", "PUT"].includes(method)) {
    const origin = c.req.header("origin");
    if (origin) {
      const host = (c.req.header("host") || new URL(c.req.url).host).toLowerCase();
      const originHost = new URL(origin).host.toLowerCase();
      if (originHost && originHost !== host) {
        return c.json({ detail: "跨站请求被拒绝" }, 403);
      }
    }
  }
  await next();
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.set("referrer-policy", "same-origin");
  c.res.headers.set("x-robots-tag", "noindex, nofollow");
  c.res.headers.set("content-security-policy", "frame-ancestors 'self'");
});

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await app.fetch(request, env, ctx);
    } catch (e) {
      return errorResponse(e);
    }
  },

  async queue(batch, env: Env): Promise<void> {
    await handleQueueBatch(batch as unknown as MessageBatch<GenerationMessage>, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;
    ctx.waitUntil((async () => {
      try {
        if (cron === "*/15 * * * *") {
          const n = await reconcilePending(env);
          if (n) console.log("billing reconciled", n);
        } else if (cron === "*/5 * * * *") {
          await sweepQueued(env);
          await recoverStuckJobs(env);
        } else {
          await cleanupExpired(env);
        }
      } catch (e) {
        console.error("scheduled task failed", e);
      }
    })());
  },
} satisfies ExportedHandler<Env>;
