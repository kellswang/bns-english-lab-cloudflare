/**
 * Anthropic Messages 原生协议适配器 —— anthropic_messages.py 的翻译。
 * 事件:message_start(rid + input tokens) → content_block_delta.text_delta →
 *       message_delta(output_tokens) → error(不可重试)。
 * 思考:thinking.budget_tokens;ultra(adaptive)+ anthropic-beta 头。
 * 隐藏推理(thinking_delta)不下发、不保存。
 */
import type { Env } from "../../types";
import { chatBase, authHeaders, type ChatRequest, type ProviderEvent, ProviderError, friendlyUpstreamError, parseSseStream } from "./base";

function buildPayload(env: Env, req: ChatRequest, stream: boolean): { payload: Record<string, unknown>; headers: Record<string, string> } {
  const thinking = req.thinking as { thinking?: unknown; anthropic_beta?: string };
  let maxTokens = req.max_output_tokens;
  const t = thinking.thinking as { type?: string; budget_tokens?: number } | null;
  if (t && typeof t.budget_tokens === "number" && t.budget_tokens >= maxTokens) {
    maxTokens = t.budget_tokens + 2048;
  }
  const headers: Record<string, string> = {
    ...authHeaders(env),
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (thinking.anthropic_beta) headers["anthropic-beta"] = thinking.anthropic_beta;

  const messages = req.messages.map((m) => {
    const content: Array<Record<string, unknown>> = [];
    for (const img of m.images) {
      content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.b64 } });
    }
    content.push({ type: "text", text: m.text || "(空消息)" });
    return { role: m.role, content };
  });

  const payload: Record<string, unknown> = {
    model: req.model.api_model,
    max_tokens: maxTokens,
    system: req.system,
    messages,
    stream,
  };
  if (t) payload.thinking = t;
  return { payload, headers };
}

export async function* streamAnthropicMessages(env: Env, req: ChatRequest): AsyncGenerator<ProviderEvent> {
  const { payload, headers } = buildPayload(env, req, true);
  const res = await fetch(`${chatBase(env)}/messages`, {
    method: "POST", headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  }).catch((e) => {
    throw new ProviderError("模型服务连接失败,请稍后重试", e?.name === "TimeoutError");
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    let msg = "";
    try { msg = String((JSON.parse(text) as any)?.error?.message || text.slice(0, 160)); } catch { msg = text.slice(0, 160); }
    throw new ProviderError(friendlyUpstreamError(res.status, msg), res.status === 429 || res.status >= 500);
  }

  let requestId = res.headers.get("x-request-id") || "";
  let usage: Record<string, number> = {};
  let metaEmitted = false;
  for await (const frame of parseSseStream(res.body)) {
    if (!frame.data) continue;
    let ev: any;
    try { ev = JSON.parse(frame.data); } catch { continue; }
    const type = String(ev.type || "");
    if (type === "message_start") {
      const rid = res.headers.get("x-request-id") || String(ev.message?.id || "");
      if (rid) requestId = requestId || rid;
      const u = ev.message?.usage || {};
      usage.prompt_tokens = Number(u.input_tokens || 0);
      usage.cached_tokens = Number(u.cache_read_input_tokens || 0);
      if (requestId) { yield { type: "meta", request_id: requestId }; metaEmitted = true; }
    } else if (type === "content_block_delta") {
      // thinking_delta 明确忽略(不保存隐藏推理原文)
      if (ev.delta?.type === "text_delta" && ev.delta.text) {
        yield { type: "text", delta: String(ev.delta.text) };
      }
    } else if (type === "message_delta") {
      const u = ev.usage || {};
      usage.completion_tokens = Number(u.output_tokens || usage.completion_tokens || 0);
      usage.total_tokens = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    } else if (type === "error") {
      const msg = String(ev.error?.message || "生成失败");
      yield { type: "error", message: msg };
      return;
    }
  }
  if (usage.completion_tokens) yield { type: "usage", usage };
  if (!metaEmitted && requestId) yield { type: "meta", request_id: requestId };
  yield { type: "done" };
}

export async function completeAnthropicMessages(env: Env, req: ChatRequest): Promise<{ text: string; request_id: string; usage: Record<string, number> }> {
  const { payload, headers } = buildPayload(env, req, false);
  const res = await fetch(`${chatBase(env)}/messages`, {
    method: "POST", headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(friendlyUpstreamError(res.status, text.slice(0, 200)));
  }
  const data = await res.json<any>();
  const text = (data.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
  return {
    text,
    request_id: res.headers.get("x-request-id") || String(data.id || ""),
    usage: {
      prompt_tokens: Number(data.usage?.input_tokens || 0),
      completion_tokens: Number(data.usage?.output_tokens || 0),
      total_tokens: Number(data.usage?.input_tokens || 0) + Number(data.usage?.output_tokens || 0),
    },
  };
}
