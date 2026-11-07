/**
 * 对话业务层 —— chat/service.py 的翻译:上下文构建、历史压缩、流式编排与持久化。
 *
 * Workers 差异:
 * - 停止信号:进程内 _stop_flags 不可跨实例,改为 chat_messages.stop_requested 列;
 *   流式循环每 ~1.5s 读一次 D1(对 120 秒回答约 80 行读,D1 免费额度内),
 *   前端 AbortController 同时生效。
 * - checkpoint 落库为短事务 UPDATE,不跨网络持有事务。
 */
import { one, run, nowIso } from "../storage/db";
import type { Env } from "../types";
import { estimateTokens } from "./tokens";
import { getChatModel, resolveThinking, type ThinkingLevel } from "./capabilities";
import type { ChatRequest, ChatMessageIn, ProviderEvent } from "./providers/base";
import { streamOpenAIResponses, completeOpenAIResponses } from "./providers/openaiResponses";
import { streamAnthropicMessages, completeAnthropicMessages } from "./providers/anthropicMessages";
import { streamGoogleGemini, completeGoogleGemini } from "./providers/googleGemini";
import { ProviderError } from "./providers/base";

export const SYSTEM_PROMPT = `你是北京第一实验学校(BNS)小学英语教研组的教学助理,服务对象是英语教师。

工作原则:
1. 用中文回答,除非教师要求英文;涉及英语表达时给出可直接用于课堂的例句。
2. 回答要能直接落地:给教案就写清目标、步骤、时间分配与板书;给练习就标注难度与参考答案。
3. 不编造教材原文、课标条款、数据或链接。不确定时明确说明,并给出核实方式。
4. 结构清晰:先给结论,再给依据或步骤;能用表格就用表格,避免空话与套话。
5. 涉及学生信息时遵守隐私原则,不复述可识别的个人信息。
6. 不展示内部推理过程,只给结论与必要的解释。`;

const MAX_OUTPUT_DEFAULT = 4096;
export const IMAGE_TOKEN_COST = 1200;
export const MAX_TEXT_CHARS = 60_000;

export interface DbAttachment {
  id: string;
  kind: "image" | "pdf" | "docx" | "text";
  filename: string;
  extracted_text: string | null;
}

export interface HistoryMsg {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  attachments: Array<{ id: string; kind: string }>;
}

export function estimateTokensOf(text: string): number {
  return estimateTokens(text);
}

/** 按预算从最新往回挑选历史;装不下的前缀交给摘要。 */
export function selectHistory(
  history: HistoryMsg[],
  attachmentMap: Map<string, DbAttachment>,
  model: { context_window: number; max_output_tokens: number },
  summary: string | null,
  maxOutput?: number,
): { picked: HistoryMsg[]; droppedCount: number; budget: number; outMax: number } {
  const outMax = Math.min(maxOutput || model.max_output_tokens, MAX_OUTPUT_DEFAULT);
  let budget = model.context_window - outMax - 6000;
  if (budget < 2000) budget = 2000;

  let used = estimateTokens(SYSTEM_PROMPT) + estimateTokens(summary || "");
  const pickedRev: HistoryMsg[] = [];
  let split = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (!m) break;
    let cost = estimateTokens(m.content || "");
    for (const a of m.attachments || []) {
      if (a.kind === "image") cost += IMAGE_TOKEN_COST;
      else {
        const row = attachmentMap.get(a.id);
        if (row?.extracted_text) cost += estimateTokens(row.extracted_text);
      }
    }
    if (used + cost <= budget || pickedRev.length === 0) {
      pickedRev.push(m);
      used += cost;
    } else {
      split = i + 1;
      break;
    }
  }
  return { picked: pickedRev.reverse(), droppedCount: split, budget, outMax };
}

/** 超预算单条消息:裁正文并明确标注截断(不静默丢弃)。 */
export function fitText(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "\n\n【内容过长,已截断,仅前半部分进入本次上下文】";
}

export async function buildChatRequest(opts: {
  modelId: string;
  thinking: ThinkingLevel;
  history: HistoryMsg[];
  attachmentMap: Map<string, DbAttachment>;
  summary: string | null;
  /** P1.3: 惰性取图 - 只为选中消息的图片附件发起 R2 读取 + base64 */
  getImagesById: (id: string) => Promise<{ mime: string; b64: string } | null>;
  maxOutput?: number;
}): Promise<ChatRequest> {
  const model = getChatModel(opts.modelId);
  if (!model) throw new ProviderError("模型不在允许清单内");
  if (model.status !== "ok") {
    throw new ProviderError(`${model.label} 当前不可用:${model.status_reason || ""}`);
  }
  const thinkingParams = resolveThinking(model, opts.thinking);

  const sel = selectHistory(opts.history, opts.attachmentMap, model, opts.summary, opts.maxOutput);
  const msgs: ChatMessageIn[] = [];
  for (const m of sel.picked) {
    const images: Array<{ mime: string; b64: string }> = [];
    let text = m.content || "";
    for (const a of m.attachments || []) {
      if (a.kind === "image") {
        if (m.role === "user") {
          const img = await opts.getImagesById(a.id);
          if (img) images.push(img);
        }
      } else {
        const row = opts.attachmentMap.get(a.id);
        if (row?.extracted_text) text += `\n\n【附件:${row.filename}】\n${row.extracted_text}`;
      }
    }
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", text, images: m.role === "assistant" ? [] : images });
  }

  // 单条超预算:裁最后一条正文并标注
  const usedEstimate = sel.picked.reduce((s, m) => {
    let c = estimateTokens(m.content || "");
    for (const a of m.attachments || []) {
      if (a.kind === "image") c += IMAGE_TOKEN_COST;
      else {
        const row = opts.attachmentMap.get(a.id);
        if (row?.extracted_text) c += estimateTokens(row.extracted_text);
      }
    }
    return s + c;
  }, estimateTokens(SYSTEM_PROMPT) + estimateTokens(opts.summary || ""));
  if (msgs.length && usedEstimate > sel.budget) {
    const overflow = usedEstimate - sel.budget;
    const last = msgs[msgs.length - 1];
    if (last) {
      last.text = fitText(last.text, Math.max(200, estimateTokens(last.text) - overflow));
    }
  }

  let system = SYSTEM_PROMPT;
  if (opts.summary) {
    system += opts.summary.startsWith("【")
      ? `\n\n${opts.summary}`
      : `\n\n以下是本会话较早内容的摘要(原始记录仍完整保存,教师可随时回看):\n${opts.summary}`;
  }

  return { model, thinking: thinkingParams, system, messages: msgs, max_output_tokens: sel.outMax };
}

const ADAPTERS = {
  openai_responses: { stream: streamOpenAIResponses, complete: completeOpenAIResponses },
  anthropic_messages: { stream: streamAnthropicMessages, complete: completeAnthropicMessages },
  google_gemini: { stream: streamGoogleGemini, complete: completeGoogleGemini },
} as const;

/** 历史压缩摘要;失败退化为结构化索引,绝不静默丢弃。 */
export async function summarizeHistory(
  env: Env, opts: { modelId: string; dropped: HistoryMsg[]; previous: string | null },
): Promise<{ text: string; meta: { request_id: string; usage: Record<string, number>; model: string } }> {
  const model = getChatModel(opts.modelId) || getChatModel("gpt-6.1-sol")!;
  const lines: string[] = [];
  if (opts.previous) lines.push("已有摘要:\n" + opts.previous);
  for (const m of opts.dropped.slice(-40)) {
    lines.push(`${m.role === "user" ? "教师" : "助手"}:${(m.content || "").slice(0, 800)}`);
  }
  const body = lines.join("\n").slice(0, 24000);
  const prompt = "把下面的对话压缩成不超过 800 字的中文摘要,必须保留:教师明确的教学任务与约束、已确定的设定(年级、单元、课时、人物、格式要求)、尚未解决的问题。只输出摘要正文,不要评论。\n\n" + body;
  const meta = { request_id: "", usage: {} as Record<string, number>, model: model.id };
  try {
    const res = await ADAPTERS[model.transport].complete(env, {
      model, thinking: {}, system: "你是严谨的对话摘要器。",
      messages: [{ role: "user", text: prompt, images: [] }],
      max_output_tokens: 1200,
    });
    meta.request_id = res.request_id;
    meta.usage = res.usage;
    if (res.text.trim()) {
      return { text: res.text.trim().slice(0, 4000), meta };
    }
  } catch {
    // 摘要失败不阻断对话
  }
  return {
    text: "【历史压缩】以下为本会话较早内容要点(自动整理,原文仍完整保留):\n" +
      lines.slice(-20).map((l) => `- ${l.slice(0, 160)}`).join("\n"),
    meta,
  };
}

// ---------------- 流式编排 ----------------
const CHECKPOINT_SECONDS = 1.2;
const CHECKPOINT_CHARS = 600;
const STOP_POLL_SECONDS = 1.5;

export interface StreamContext {
  env: Env;
  conversationId: string;
  assistantId: string;
  req: ChatRequest;
}

/** 执行一次上游调用:边收边 checkpoint;停止/断连/异常都保存已生成内容。 */
export async function* streamAnswer(
  ctx: StreamContext,
): AsyncGenerator<Record<string, unknown>> {
  const { env, conversationId, assistantId, req } = ctx;
  const adapter = ADAPTERS[req.model.transport];
  let lastStopCheck = 0;
  let stopped = false;

  let buf = "";
  let usage: Record<string, number> = {};
  let requestId = "";
  let status = "complete";
  let error: string | null = null;
  const started = Date.now();
  let lastCkAt = started;
  let lastCkLen = 0;
  let agen: AsyncGenerator<ProviderEvent> | null = null;

  const checkpoint = async (finished: boolean, finalStatus?: string) => {
    await run(
      env.DB,
      "UPDATE chat_messages SET content = ?, status = ?, usage = ?, request_id = COALESCE(?, request_id), error = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?",
      buf, finalStatus || (finished ? status : "streaming"),
      JSON.stringify(usage), requestId || null, error, finished ? nowIso() : null, assistantId,
    );
    if (finished) {
      if (finalStatus === "complete" || finalStatus === "stopped" || status === "complete" || status === "stopped") {
        if ((finalStatus || status) === "complete" || (finalStatus || status) === "stopped") {
          await run(env.DB, "UPDATE chat_conversations SET active_leaf_id = ?, last_message_at = ?, updated_at = ? WHERE id = ?",
            assistantId, nowIso(), nowIso(), conversationId);
        }
      }
    }
  };

  const shouldStop = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - lastStopCheck < STOP_POLL_SECONDS * 1000) return stopped;
    lastStopCheck = now;
    const row = await one<{ stop_requested: number }>(
      env.DB, "SELECT stop_requested FROM chat_messages WHERE id = ?", assistantId);
    return stopped || Number(row?.stop_requested ?? 0) === 1;
  };

  try {
    agen = adapter.stream(env, req);
    for await (const ev of agen) {
      if (await shouldStop()) { stopped = true; status = "stopped"; break; }
      if (ev.type === "text") {
        buf += ev.delta;
        yield { type: "delta", text: ev.delta };
        const now = Date.now();
        if (now - lastCkAt >= CHECKPOINT_SECONDS * 1000 || buf.length - lastCkLen >= CHECKPOINT_CHARS) {
          lastCkAt = now; lastCkLen = buf.length;
          await checkpoint(false);
        }
      } else if (ev.type === "meta") {
        requestId = ev.request_id || requestId;
        // 拿到上游 request id 立即落库:对账唯一线索
        await checkpoint(false);
        yield { type: "meta", request_id: requestId, model: ev.model };
      } else if (ev.type === "usage") {
        usage = ev.usage;
      } else if (ev.type === "error") {
        status = "failed";
        error = ev.message;
        yield { type: "error", message: error };
        break;
      } else if (ev.type === "done") {
        break;
      }
    }
  } catch (e) {
    status = "failed";
    error = e instanceof ProviderError ? e.message : `生成过程中断(${e instanceof Error ? e.name : "unknown"})`;
    yield { type: "error", message: error };
  } finally {
    if (agen) await agen.return(undefined as never).catch(() => {});
    if (status === "complete" && !buf.trim()) {
      status = "failed";
      error = error || "模型没有返回任何内容";
    }
    const dur = Date.now() - started;
    await checkpoint(true, status);
    yield {
      type: "finish", status, message_id: assistantId,
      usage, request_id: requestId, duration_ms: dur, error,
    };
  }
}

export function sse(event: Record<string, unknown>): string {
  return "data: " + JSON.stringify(event) + "\n\n";
}
