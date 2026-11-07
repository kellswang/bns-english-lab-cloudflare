/**
 * AI 对话接口 —— 对应原 backend/app/api/chat.py。
 * SSE 事件: start / delta / meta / error / finish + [DONE],前端零改动兼容。
 * 附件:原图按原样存 R2(多模态输入);PDF/DOCX/TXT 正文在浏览器端抽取后
 * 随表单字段传输(见 docs/FEASIBILITY.md 闸门 D),服务端限大小/类型/长度。
 */
import { Hono } from "hono";
import type { Env } from "../types";
import { loadConfig } from "../config";
import { getOptionalUser, requireActive, audit, type AppCtx } from "../auth/deps";
import { HttpError, json, naiveUtc } from "../utils/http";
import { all, one, run, nowIso } from "../storage/db";
import { R2Keys, putObject, sniffImageMime, sniffDocMime } from "../storage/r2";
import { getChatModel, publicModels, THINKING_LEVELS, DEFAULT_MODEL } from "../chat/capabilities";
import { buildChatRequest, summarizeHistory, streamAnswer, sse, type HistoryMsg } from "../chat/service";
import { ProviderError } from "../chat/providers/base";
import type { ChatConversationRow, ChatMessageRow } from "../chat/rows";

export const chatRoutes = new Hono<{ Bindings: Env }>();

const MAX_CONTENT_CHARS = 24000;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 60_000;

async function ctxOf(c: any): Promise<AppCtx> {
  return getOptionalUser(c);
}

async function convOr404(ctx: AppCtx, convId: string): Promise<ChatConversationRow> {
  const conv = await one<ChatConversationRow>(
    ctx.env.DB, "SELECT * FROM chat_conversations WHERE id = ?", convId);
  if (!conv || conv.owner_id !== ctx.user!.id || conv.status === "deleted") {
    throw new HttpError(404, "对话不存在");
  }
  return conv;
}

function msgPayload(m: ChatMessageRow): Record<string, unknown> {
  return {
    id: m.id,
    parent_id: m.parent_id,
    role: m.role,
    content: m.content,
    status: m.status,
    model: m.model,
    thinking: m.thinking,
    attachments: JSON.parse(m.attachments || "[]"),
    usage: JSON.parse(m.usage || "{}"),
    request_id: m.request_id,
    duration_ms: m.duration_ms,
    error: m.error,
    created_at: m.created_at ? naiveUtc(m.created_at) : null,
  };
}

chatRoutes.get("/chat/models", (c) => {
  const data = publicModels() as Record<string, unknown>;
  data.usage_basis = "对话按上游返回的 token 用量记录,费用以后台账单为准,不在界面展示";
  return json(data);
});

chatRoutes.get("/chat/conversations", async (c) => {
  const ctx = await ctxOf(c);
  const u = ctx.user;
  if (!u) throw new HttpError(401, "未登录或会话已过期");
  const q = (c.req.query("q") || "").trim();
  const rows = await all<ChatConversationRow>(
    c.env.DB,
    "SELECT * FROM chat_conversations WHERE owner_id = ? AND status = 'active' " +
    (q ? "AND title LIKE ? " : "") +
    "ORDER BY updated_at DESC LIMIT 200",
    ...(q ? [u.id, `%${q}%`] : [u.id]),
  );
  const counts = new Map<string, number>();
  const previews = new Map<string, string>();
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    for (const r of await all<{ conversation_id: string; n: number }>(
      c.env.DB,
      `SELECT conversation_id, COUNT(*) AS n FROM chat_messages WHERE conversation_id IN (${placeholders}) GROUP BY conversation_id`,
      ...ids,
    )) counts.set(r.conversation_id, Number(r.n));
    // 每会话最新一条用户消息做预览(窗口函数,不拉全量)
    for (const r of await all<{ conversation_id: string; content: string }>(
      c.env.DB,
      `SELECT conversation_id, content FROM (
         SELECT conversation_id, content, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at DESC) AS rn
         FROM chat_messages WHERE conversation_id IN (${placeholders}) AND role = 'user'
       ) WHERE rn = 1`,
      ...ids,
    )) previews.set(r.conversation_id, (r.content || "").slice(0, 80));
  }
  return json({
    items: rows.map((r) => ({
      id: r.id, title: r.title, model: r.model, thinking: r.thinking,
      message_count: counts.get(r.id) ?? 0,
      preview: previews.get(r.id) ?? "",
      updated_at: naiveUtc(r.updated_at || r.created_at),
    })),
  });
});

chatRoutes.post("/chat/conversations", async (c) => {
  const ctx = await ctxOf(c);
  const u = requireActive(ctx);
  const body = await c.req.json<{ title?: string; model?: string; thinking?: string }>()
    .catch(() => ({}) as { title?: string; model?: string; thinking?: string });
  const model = getChatModel(body.model || DEFAULT_MODEL);
  if (!model) throw new HttpError(400, "模型不在允许清单内");
  if (model.status !== "ok") throw new HttpError(400, `${model.label} 当前不可用,请换一个模型`);
  const id = crypto.randomUUID();
  const title = ((body.title || "新对话").trim() || "新对话").slice(0, 200);
  await run(
    c.env.DB,
    "INSERT INTO chat_conversations (id, owner_id, title, model, thinking, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
    id, u.id, title, body.model || DEFAULT_MODEL, body.thinking || "standard", nowIso(), nowIso(),
  );
  await audit(ctx, "chat.create", { entityId: id });
  return json({ id, title, model: body.model || DEFAULT_MODEL, thinking: body.thinking || "standard", created_at: naiveUtc(nowIso()) }, 201);
});

chatRoutes.patch("/chat/conversations/:convId", async (c) => {
  const ctx = await ctxOf(c);
  requireActive(ctx);
  const conv = await convOr404(ctx, c.req.param("convId"));
  const body = await c.req.json<{ title?: string; model?: string; thinking?: string }>()
    .catch(() => ({}) as { title?: string; model?: string; thinking?: string });
  if (body.title !== undefined) {
    const t = body.title.trim().slice(0, 200) || conv.title;
    await run(c.env.DB, "UPDATE chat_conversations SET title = ?, updated_at = ? WHERE id = ?", t, nowIso(), conv.id);
  }
  if (body.model !== undefined) {
    const m = getChatModel(body.model);
    if (!m) throw new HttpError(400, "模型不在允许清单内");
    if (m.status !== "ok") throw new HttpError(400, `${m.label} 当前不可用,请换一个模型`);
    await run(c.env.DB, "UPDATE chat_conversations SET model = ?, updated_at = ? WHERE id = ?", body.model, nowIso(), conv.id);
  }
  if (body.thinking !== undefined) {
    if (!THINKING_LEVELS.includes(body.thinking as never)) throw new HttpError(400, "思考深度不合法");
    await run(c.env.DB, "UPDATE chat_conversations SET thinking = ?, updated_at = ? WHERE id = ?", body.thinking, nowIso(), conv.id);
  }
  return json({ ok: true });
});

chatRoutes.delete("/chat/conversations/:convId", async (c) => {
  const ctx = await ctxOf(c);
  requireActive(ctx);
  const conv = await convOr404(ctx, c.req.param("convId"));
  await run(c.env.DB, "UPDATE chat_conversations SET status = 'deleted', updated_at = ? WHERE id = ?", nowIso(), conv.id);
  await audit(ctx, "chat.delete", { entityId: conv.id });
  return json({ ok: true });
});

chatRoutes.get("/chat/conversations/:convId", async (c) => {
  const ctx = await ctxOf(c);
  const conv = await convOr404(ctx, c.req.param("convId"));
  const rows = await all<ChatMessageRow>(
    c.env.DB, "SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at", conv.id);
  // active_path:从 active_leaf_id 回溯
  const byId = new Map(rows.map((m) => [m.id, m] as const));
  const path: string[] = [];
  let cur = conv.active_leaf_id ? byId.get(conv.active_leaf_id) : undefined;
  let guard = 0;
  while (cur && guard < 500) {
    path.push(cur.id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    guard++;
  }
  path.reverse();
  return json({
    id: conv.id, title: conv.title, model: conv.model, thinking: conv.thinking,
    summary: conv.summary, active_leaf_id: conv.active_leaf_id,
    active_path: path,
    messages: rows.map(msgPayload),
  });
});

chatRoutes.post("/chat/conversations/:convId/messages", async (c) => {
  const ctx = await ctxOf(c);
  const u = requireActive(ctx);
  const conv = await convOr404(ctx, c.req.param("convId"));
  const body = await c.req.json<{
    content?: string; model?: string; thinking?: string;
    attachment_ids?: string[]; edit_of?: string; regenerate_of?: string; client_request_id?: string;
  }>().catch(() => null);
  if (!body) throw new HttpError(422, "请求体不合法");

  const model = getChatModel(body.model || conv.model || DEFAULT_MODEL);
  if (!model) throw new HttpError(400, "模型不在允许清单内");
  if (model.status !== "ok") {
    throw new HttpError(400, `${model.label} 当前不可用:${model.status_reason || ""}`);
  }
  const thinking = (body.thinking || conv.thinking || "standard") as string;
  if (!THINKING_LEVELS.includes(thinking as never)) throw new HttpError(400, "思考深度不合法");
  const thinkingLevel = thinking as (typeof THINKING_LEVELS)[number];

  // ---- 幂等:同一次用户操作重试,重放已有回答 ----
  const clientId = (body.client_request_id || "").trim() || null;
  if (clientId) {
    const replayMsg = await one<ChatMessageRow>(
      c.env.DB,
      "SELECT * FROM chat_messages WHERE owner_id = ? AND client_request_id = ?",
      u.id, clientId,
    );
    if (replayMsg) return replayStream(c, conv, replayMsg);
  }

  // ---- 组装本轮消息(分支/edit/regenerate 语义与原实现一致) ----
  let userMsg: ChatMessageRow | null = null;
  let parentId: string | null = null;

  if (body.regenerate_of) {
    const old = await one<ChatMessageRow>(c.env.DB, "SELECT * FROM chat_messages WHERE id = ?", body.regenerate_of);
    if (!old || old.conversation_id !== conv.id || old.role !== "assistant") {
      throw new HttpError(404, "要重新生成的消息不存在");
    }
    parentId = old.parent_id;
    userMsg = parentId ? await one<ChatMessageRow>(c.env.DB, "SELECT * FROM chat_messages WHERE id = ?", parentId) : null;
  } else if (body.edit_of) {
    const old = await one<ChatMessageRow>(c.env.DB, "SELECT * FROM chat_messages WHERE id = ?", body.edit_of);
    if (!old || old.conversation_id !== conv.id || old.role !== "user") {
      throw new HttpError(404, "要编辑的消息不存在");
    }
    parentId = old.parent_id;
  } else {
    parentId = conv.active_leaf_id;
  }

  const content = (body.content || "").trim();
  const attIds = (body.attachment_ids || []).slice(0, 6);
  if (!userMsg) {
    if (!content && !attIds.length) throw new HttpError(400, "请输入内容或添加附件");
    if (content.length > MAX_CONTENT_CHARS) throw new HttpError(400, "内容过长");
    const metas: Array<Record<string, unknown>> = [];
    for (const aid of attIds) {
      const row = await one<{ id: string; kind: string; filename: string; content_type: string; size_bytes: number; owner_id: string; conversation_id: string }>(
        c.env.DB, "SELECT * FROM chat_attachments WHERE id = ?", aid);
      if (!row || row.owner_id !== u.id || row.conversation_id !== conv.id) {
        throw new HttpError(400, "附件不存在或不属于本会话");
      }
      metas.push({ id: row.id, kind: row.kind, filename: row.filename, content_type: row.content_type, size_bytes: row.size_bytes });
    }
    const newId = crypto.randomUUID();
    await run(
      c.env.DB,
      "INSERT INTO chat_messages (id, conversation_id, owner_id, parent_id, role, content, status, attachments, created_at) VALUES (?, ?, ?, ?, 'user', ?, 'complete', ?, ?)",
      newId, conv.id, u.id, parentId, content, JSON.stringify(metas), nowIso(),
    );
    userMsg = await one<ChatMessageRow>(c.env.DB, "SELECT * FROM chat_messages WHERE id = ?", newId);
  }
  if (!userMsg) throw new HttpError(500, "消息创建失败");

  // ---- 历史与上下文 ----
  const allMsgs = await all<ChatMessageRow>(
    c.env.DB, "SELECT id, parent_id, role, content, attachments FROM chat_messages WHERE conversation_id = ?", conv.id);
  const byId = new Map(allMsgs.map((m) => [m.id, m] as const));
  const history: HistoryMsg[] = [];
  let cur: ChatMessageRow | undefined = byId.get(userMsg.id);
  let guard = 0;
  while (cur && guard < 500) {
    history.push({
      id: cur.id, role: cur.role as HistoryMsg["role"], content: cur.content,
      attachments: JSON.parse(cur.attachments || "[]"),
    });
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    guard++;
  }
  history.reverse();

  const attIdSet = new Set(history.flatMap((m) => m.attachments.map((a) => a.id)));
  const attachmentMap = new Map<string, { id: string; kind: "image" | "pdf" | "docx" | "text"; filename: string; extracted_text: string | null }>();
  const imagesById = new Map<string, { mime: string; b64: string }>();
  if (attIdSet.size) {
    const rows = await all<{ id: string; kind: string; filename: string; extracted_text: string | null; rel_path: string; content_type: string }>(
      c.env.DB, `SELECT id, kind, filename, extracted_text, rel_path, content_type FROM chat_attachments WHERE id IN (${[...attIdSet].map(() => "?").join(",")})`,
      ...attIdSet,
    );
    for (const r of rows) {
      attachmentMap.set(r.id, { id: r.id, kind: r.kind as never, filename: r.filename, extracted_text: r.extracted_text });
      if (r.kind === "image") {
        const obj = await c.env.MEDIA.get(r.rel_path);
        if (obj) {
          const buf = await obj.arrayBuffer();
          imagesById.set(r.id, { mime: r.content_type || "image/png", b64: arrayBufferToBase64(buf) });
        }
      }
    }
  }

  // 摘要仅在覆盖前缀属于当前分支时可用
  let summary = conv.summary && (!conv.summary_upto_id || history.some((m) => m.id === conv.summary_upto_id))
    ? conv.summary : null;

  let req;
  try {
    req = buildChatRequest({ modelId: model.id, thinking: thinkingLevel, history, attachmentMap, summary, imagesById });
  } catch (e) {
    if (e instanceof ProviderError) throw new HttpError(400, e.message);
    throw e;
  }

  // 超预算:压缩被丢弃的前缀(原文保留,摘要记录可对账)
  const droppedCount = history.length - req.messages.length;
  if (droppedCount > 0) {
    const dropped = history.slice(0, droppedCount);
    const lastDropped = dropped[dropped.length - 1];
    const s = await summarizeHistory(c.env, { modelId: model.id, dropped, previous: summary });
    summary = s.text;
    await run(
      c.env.DB,
      "UPDATE chat_conversations SET summary = ?, summary_upto_id = ?, summary_leaf_id = ? WHERE id = ?",
      s.text, lastDropped?.id ?? null, userMsg.id, conv.id,
    );
    if (s.meta.request_id) {
      await run(
        c.env.DB,
        "INSERT INTO summary_calls (id, conversation_id, owner_id, model, upto_message_id, request_id, usage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        crypto.randomUUID(), conv.id, u.id, s.meta.model, lastDropped?.id ?? null,
        s.meta.request_id, JSON.stringify(s.meta.usage), nowIso(),
      );
    }
    // 摘要后重建请求
    try {
      req = buildChatRequest({ modelId: model.id, thinking: thinkingLevel, history, attachmentMap, summary, imagesById });
    } catch (e) {
      if (e instanceof ProviderError) throw new HttpError(400, e.message);
      throw e;
    }
  }

  const assistantId = crypto.randomUUID();
  await run(
    c.env.DB,
    "INSERT INTO chat_messages (id, conversation_id, owner_id, parent_id, role, content, status, model, thinking, client_request_id, created_at) VALUES (?, ?, ?, ?, 'assistant', '', 'streaming', ?, ?, ?, ?)",
    assistantId, conv.id, u.id, userMsg.id, model.id, thinking, clientId, nowIso(),
  );
  await run(
    c.env.DB,
    "UPDATE chat_conversations SET model = ?, thinking = ?, active_leaf_id = ?, last_message_at = ?, updated_at = ?, " +
    "title = CASE WHEN title IN ('', '新对话') AND ? != '' THEN substr(replace(?, char(10), ' '), 1, 40) ELSE title END WHERE id = ?",
    model.id, thinking, assistantId, nowIso(), nowIso(), content, content, conv.id,
  );

  const convIdFinal = conv.id;
  const userMsgId = userMsg.id;
  const titleFinal = (await one<{ title: string }>(c.env.DB, "SELECT title FROM chat_conversations WHERE id = ?", conv.id))?.title || conv.title;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const push = (s: string) => controller.enqueue(enc.encode(s));
      try {
        push(sse({
          type: "start", conversation_id: convIdFinal, user_message_id: userMsgId,
          assistant_message_id: assistantId, model: model.id, thinking, title: titleFinal,
        }));
        for await (const ev of streamAnswer({
          env: c.env, conversationId: convIdFinal, assistantId, req,
        })) {
          push(sse(ev));
        }
        push("data: [DONE]\n\n");
      } catch (e) {
        console.error("chat stream error", e);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

function replayStream(c: any, conv: ChatConversationRow, msg: ChatMessageRow): Response {
  const stored = msg.content || "";
  const status = ["complete", "stopped", "failed", "interrupted"].includes(msg.status) ? msg.status : "interrupted";
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      controller.enqueue(enc.encode(sse({
        type: "start", conversation_id: conv.id,
        user_message_id: msg.parent_id, assistant_message_id: msg.id,
        model: msg.model, thinking: msg.thinking, title: conv.title, replayed: true,
      })));
      if (stored) controller.enqueue(enc.encode(sse({ type: "delta", text: stored })));
      controller.enqueue(enc.encode(sse({
        type: "finish", status, message_id: msg.id,
        usage: JSON.parse(msg.usage || "{}"), request_id: msg.request_id,
        duration_ms: msg.duration_ms, error: msg.error, replayed: true,
      })));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });
}

// ---------------- 停止 / 分支切换 ----------------
chatRoutes.post("/chat/messages/:messageId/stop", async (c) => {
  const ctx = await ctxOf(c);
  requireActive(ctx);
  const m = await one<{ id: string; owner_id: string }>(
    c.env.DB, "SELECT id, owner_id FROM chat_messages WHERE id = ?", c.req.param("messageId"));
  if (!m || m.owner_id !== ctx.user!.id) throw new HttpError(404, "消息不存在");
  // 跨实例可见:写入 D1,流式循环周期性读取
  await run(c.env.DB, "UPDATE chat_messages SET stop_requested = 1 WHERE id = ?", m.id);
  return json({ ok: true });
});

chatRoutes.post("/chat/messages/:messageId/activate", async (c) => {
  const ctx = await ctxOf(c);
  requireActive(ctx);
  const m = await one<{ id: string; owner_id: string; conversation_id: string }>(
    c.env.DB, "SELECT id, owner_id, conversation_id FROM chat_messages WHERE id = ?", c.req.param("messageId"));
  if (!m || m.owner_id !== ctx.user!.id) throw new HttpError(404, "消息不存在");
  const conv = await convOr404(ctx, m.conversation_id);
  const rows = await all<{ id: string; parent_id: string | null; created_at: string }>(
    c.env.DB, "SELECT id, parent_id, created_at FROM chat_messages WHERE conversation_id = ?", conv.id);
  const children = new Map<string, Array<{ id: string; created_at: string }>>();
  for (const r of rows) {
    if (r.parent_id) {
      const list = children.get(r.parent_id) || [];
      list.push({ id: r.id, created_at: r.created_at });
      children.set(r.parent_id, list);
    }
  }
  let cur = m.id;
  let guard = 0;
  while (children.has(cur) && guard < 500) {
    const list = (children.get(cur) || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const next = list[list.length - 1];
    if (!next) break;
    cur = next.id;
    guard++;
  }
  await run(c.env.DB, "UPDATE chat_conversations SET active_leaf_id = ?, updated_at = ? WHERE id = ?", cur, nowIso(), conv.id);
  return json({ ok: true, active_leaf_id: cur });
});

// ---------------- 附件 ----------------
chatRoutes.post("/chat/conversations/:convId/attachments", async (c) => {
  const ctx = await ctxOf(c);
  const u = requireActive(ctx);
  const conv = await convOr404(ctx, c.req.param("convId"));
  const form = await c.req.parseBody();
  const file = form.file;
  if (!(file instanceof File)) throw new HttpError(400, "缺少文件");
  const raw = await file.arrayBuffer();
  if (!raw.byteLength) throw new HttpError(400, "文件为空");
  if (raw.byteLength > MAX_ATTACHMENT_BYTES) throw new HttpError(413, "附件不能超过 20 MB");

  const head = new Uint8Array(raw.slice(0, 16));
  const filename = (file.name || "file").slice(0, 255);
  const declaredText = typeof form.extracted_text === "string" ? form.extracted_text : "";
  const declaredPages = Number(form.page_count || 0) || null;
  const declaredTruncated = String(form.text_truncated || "") === "1" || String(form.text_truncated || "") === "true";

  let kind: "image" | "pdf" | "docx" | "text";
  let contentType: string;
  let width: number | null = null;
  let height: number | null = null;
  let extracted: string | null = null;
  let truncated = false;

  const imgMime = sniffImageMime(head);
  if (imgMime) {
    kind = "image";
    contentType = imgMime;
    // 图片像素上限约 40MP:读取 PNG/JPEG 头部尺寸(浏览器端也会预检)
    const dims = readImageDimensions(head, new Uint8Array(raw));
    if (dims && dims[0] * dims[1] > 40_000_000) throw new HttpError(400, "图片像素数量过大,已拒绝处理");
    width = dims?.[0] ?? null;
    height = dims?.[1] ?? null;
  } else {
    const docKind = sniffDocMime(head, filename);
    if (docKind === "pdf") {
      kind = "pdf"; contentType = "application/pdf";
    } else if (docKind === "docx") {
      kind = "docx"; contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else if (/\.(txt|md|csv|json)$/i.test(filename)) {
      kind = "text"; contentType = "text/plain; charset=utf-8";
    } else {
      throw new HttpError(400, "不支持的文件格式");
    }
    // 正文来自浏览器端解析(PDF.js / DOCX 解压);服务端限长并如实记录截断
    extracted = declaredText ? declaredText.slice(0, MAX_EXTRACTED_CHARS) : null;
    truncated = declaredTruncated || (declaredText ? declaredText.length > MAX_EXTRACTED_CHARS : false);
    if (kind === "pdf" && !extracted) {
      // 扫描件/无文本 PDF:如实标记,服务端不假装读过
      truncated = false;
    }
  }

  const attId = crypto.randomUUID();
  const key = R2Keys.attachment(conv.id, attId);
  await putObject(c.env, key, raw, contentType.split(";")[0] || contentType, { length: raw.byteLength });
  try {
    await run(
      c.env.DB,
      "INSERT INTO chat_attachments (id, conversation_id, owner_id, filename, content_type, kind, size_bytes, rel_path, width, height, extracted_text, page_count, text_truncated, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      attId, conv.id, u.id, filename, contentType, kind, raw.byteLength, key, width, height,
      extracted, declaredPages && declaredPages <= 999 ? declaredPages : null, truncated ? 1 : 0, nowIso(),
    );
  } catch {
    // R2 已写、D1 失败:清理孤儿对象
    await c.env.MEDIA.delete(key);
    throw new HttpError(500, "附件保存失败,请重试");
  }
  return json({
    id: attId, filename, kind, content_type: contentType, size_bytes: raw.byteLength,
    width, height, page_count: kind === "pdf" ? declaredPages : null,
    has_text: Boolean(extracted), text_truncated: truncated,
  }, 201);
});

chatRoutes.get("/chat/attachments/:attachmentId/file", async (c) => {
  const ctx = await ctxOf(c);
  const u = ctx.user;
  if (!u) throw new HttpError(401, "未登录或会话已过期");
  const row = await one<{ owner_id: string; rel_path: string; content_type: string; filename: string }>(
    c.env.DB, "SELECT owner_id, rel_path, content_type, filename FROM chat_attachments WHERE id = ?", c.req.param("attachmentId"));
  if (!row || row.owner_id !== u.id) throw new HttpError(404, "附件不存在");
  const obj = await c.env.MEDIA.get(row.rel_path);
  if (!obj) throw new HttpError(404, "附件文件缺失");
  const headers = new Headers({
    "content-type": row.content_type,
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=600",
    "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
  });
  return new Response(obj.body, { headers });
});

chatRoutes.get("/chat/usage", async (c) => {
  const ctx = await ctxOf(c);
  const u = ctx.user;
  if (!u) throw new HttpError(401, "未登录或会话已过期");
  const row = await one<{ p: number | null; comp: number | null; cached: number | null; answers: number }>(
    c.env.DB,
    "SELECT " +
    "COALESCE(SUM(CAST(json_extract(usage, '$.prompt_tokens') AS INTEGER)), 0) AS p, " +
    "COALESCE(SUM(CAST(json_extract(usage, '$.completion_tokens') AS INTEGER)), 0) AS comp, " +
    "COALESCE(SUM(CAST(json_extract(usage, '$.cached_tokens') AS INTEGER)), 0) AS cached, " +
    "COUNT(*) AS answers FROM chat_messages WHERE owner_id = ? AND role = 'assistant'",
    u.id,
  );
  const prompt = Number(row?.p ?? 0);
  const completion = Number(row?.comp ?? 0);
  return json({
    answers: Number(row?.answers ?? 0),
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cached_tokens: Number(row?.cached ?? 0),
    basis: "upstream_reported_usage",
    note: "按上游返回的 token 用量记录;上游实际扣费以后台账单为准,这里不做换算",
  });
});

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 从 PNG/JPEG 头部读取像素尺寸(不完整解码)。 */
function readImageDimensions(head: Uint8Array, raw: Uint8Array): [number, number] | null {
  // PNG: IHDR 在固定偏移
  if (head[0] === 0x89 && raw.length >= 24) {
    const view = new DataView(raw.buffer, raw.byteOffset);
    return [view.getUint32(16), view.getUint32(20)];
  }
  // JPEG: 扫 SOF0-SOF3 段
  if (head[0] === 0xff && head[1] === 0xd8) {
    const view = new DataView(raw.buffer, raw.byteOffset);
    let i = 2;
    while (i + 9 < raw.length) {
      if (view.getUint8(i) !== 0xff) { i++; continue; }
      const marker = view.getUint8(i + 1);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return [view.getUint16(i + 7), view.getUint16(i + 5)];
      }
      const len = view.getUint16(i + 2);
      i += 2 + len;
    }
  }
  return null;
}
