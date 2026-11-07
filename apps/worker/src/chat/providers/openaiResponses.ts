/**
 * OpenAI Responses 原生协议适配器 —— openai_responses.py 的翻译。
 * 事件:response.created(rid) → response.output_text.delta → response.completed(usage)
 * 思考:reasoning.effort(fast=minimal standard=medium deep=high ultra=xhigh)
 */
import type { Env } from "../../types";
import { chatBase, authHeaders, type ChatRequest, type ProviderEvent, ProviderError, friendlyUpstreamError, parseSseStream } from "./base";

interface ResponsesPayload {
  model?: string;
  instructions?: string;
  input?: unknown;
  reasoning?: Record<string, string>;
  max_output_tokens?: number;
  stream?: boolean;
}

function buildPayload(req: ChatRequest, stream: boolean): ResponsesPayload {
  const payload: ResponsesPayload = {
    model: req.model.api_model,
    instructions: req.system,
    max_output_tokens: req.max_output_tokens,
    stream,
  };
  Object.assign(payload, req.thinking); // reasoning: {effort}
  payload.input = req.messages.map((m) => {
    if (!m.images.length && m.role === "assistant") return { role: m.role, content: m.text };
    if (!m.images.length) return { role: m.role, content: m.text };
    const content: Array<Record<string, string>> = [];
    for (const img of m.images) {
      content.push({ type: "input_image", image_url: `data:${img.mime};base64,${img.b64}` });
    }
    content.push({ type: "input_text", text: m.text || "(空消息)" });
    return { role: m.role, content };
  });
  return payload;
}

export async function* streamOpenAIResponses(env: Env, req: ChatRequest): AsyncGenerator<ProviderEvent> {
  const res = await fetch(`${chatBase(env)}/responses`, {
    method: "POST",
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body: JSON.stringify(buildPayload(req, true)),
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
  let metaEmitted = false;
  for await (const frame of parseSseStream(res.body)) {
    if (!frame.data) continue;
    let ev: any;
    try { ev = JSON.parse(frame.data); } catch { continue; }
    const type = String(ev.type || "");
    if (type === "response.created") {
      const rid = res.headers.get("x-request-id") || String(ev.response?.id || "");
      if (rid) {
        requestId = requestId || rid;
        yield { type: "meta", request_id: requestId, model: ev.response?.model };
        metaEmitted = true;
      }
    } else if (type === "response.output_text.delta") {
      if (ev.delta) yield { type: "text", delta: String(ev.delta) };
    } else if (type === "response.completed") {
      const u = ev.response?.usage || {};
      yield {
        type: "usage",
        usage: {
          prompt_tokens: Number(u.input_tokens || 0),
          completion_tokens: Number(u.output_tokens || 0),
          total_tokens: Number(u.total_tokens || 0),
          cached_tokens: Number(u.input_tokens_details?.cached_tokens || 0),
          reasoning_tokens: Number(u.output_tokens_details?.reasoning_tokens || 0),
        },
      };
      yield { type: "done", stop_reason: ev.response?.status === "incomplete" ? "incomplete" : "completed" };
    } else if (type === "response.failed" || type === "error") {
      const msg = String(ev.response?.error?.message || ev.error?.message || "生成失败");
      yield { type: "error", message: msg };
      return;
    }
  }
  if (!metaEmitted && requestId) {
    yield { type: "meta", request_id: requestId };
  }
}

export async function completeOpenAIResponses(env: Env, req: ChatRequest): Promise<{ text: string; request_id: string; usage: Record<string, number> }> {
  const res = await fetch(`${chatBase(env)}/responses`, {
    method: "POST",
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body: JSON.stringify(buildPayload(req, false)),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(friendlyUpstreamError(res.status, text.slice(0, 200)));
  }
  const data = await res.json<any>();
  let text = data.output_text || "";
  if (!text && Array.isArray(data.output)) {
    for (const out of data.output) {
      for (const c of out.content || []) {
        if (c.type === "output_text" || c.text) text += c.text || "";
      }
    }
  }
  const u = data.usage || {};
  return {
    text,
    request_id: res.headers.get("x-request-id") || String(data.id || ""),
    usage: {
      prompt_tokens: Number(u.input_tokens || 0),
      completion_tokens: Number(u.output_tokens || 0),
      total_tokens: Number(u.total_tokens || 0),
    },
  };
}
