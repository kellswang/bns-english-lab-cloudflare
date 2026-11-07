/**
 * Google Gemini 原生协议适配器 —— google_gemini.py 的翻译。
 * 端点:{root}/v1beta/models/{id}:streamGenerateContent?alt=sse(流式)
 *       / :generateContent(非流式)。
 * 思考:generationConfig.thinkingConfig.thinkingBudget。
 * 特例:responseId 常在流末尾才出现 → 流结束后补发 meta(与原实现一致)。
 */
import type { Env } from "../../types";
import { apiRoot, authHeaders, type ChatRequest, type ProviderEvent, ProviderError, friendlyUpstreamError, parseSseStream } from "./base";

function buildPayload(env: Env, req: ChatRequest, stream: boolean): { url: string; body: string } {
  const cfg = req.thinking as { thinkingConfig?: Record<string, unknown> };
  const contents = req.messages.map((m) => {
    const parts: Array<Record<string, unknown>> = [];
    for (const img of m.images) {
      parts.push({ inline_data: { mime_type: img.mime, data: img.b64 } });
    }
    parts.push({ text: m.text || "(空消息)" });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
  const body = JSON.stringify({
    contents,
    systemInstruction: { parts: [{ text: req.system }] },
    generationConfig: {
      maxOutputTokens: req.max_output_tokens,
      ...(cfg.thinkingConfig ? { thinkingConfig: cfg.thinkingConfig } : {}),
    },
  });
  const verb = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  const url = `${apiRoot(env)}/v1beta/models/${req.model.api_model}:${verb}`;
  return { url, body };
}

export async function* streamGoogleGemini(env: Env, req: ChatRequest): AsyncGenerator<ProviderEvent> {
  const { url, body } = buildPayload(env, req, true);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body,
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

  const headerRid = res.headers.get("x-request-id") || "";
  let responseId = "";
  let usage: Record<string, number> = {};
  for await (const frame of parseSseStream(res.body)) {
    if (!frame.data) continue;
    let ev: any;
    try { ev = JSON.parse(frame.data); } catch { continue; }
    if (ev.error) {
      const retryable = ["UNAVAILABLE", "RESOURCE_EXHAUSTED"].includes(String(ev.error.status || ""));
      yield { type: "error", message: friendlyUpstreamError(Number(ev.error.code || 500), String(ev.error.message || "")), retryable };
      return;
    }
    if (ev.responseId) responseId = String(ev.responseId);
    if (ev.usageMetadata) {
      usage = {
        prompt_tokens: Number(ev.usageMetadata.promptTokenCount || 0),
        completion_tokens: Number(ev.usageMetadata.candidatesTokenCount || 0),
        total_tokens: Number(ev.usageMetadata.totalTokenCount || 0),
        cached_tokens: Number(ev.usageMetadata.cachedContentTokenCount || 0),
        reasoning_tokens: Number(ev.usageMetadata.thoughtsTokenCount || 0),
      };
    }
    for (const cand of ev.candidates || []) {
      for (const part of cand.content?.parts || []) {
        if (part.text) yield { type: "text", delta: String(part.text) };
      }
      if (cand.finishReason) {
        yield { type: "done", stop_reason: String(cand.finishReason) };
      }
    }
  }
  if (Object.keys(usage).length) yield { type: "usage", usage };
  // responseId 常在流末尾才出现:流结束后补发 meta 保证 request_id 落库
  const rid = headerRid || responseId;
  if (rid) yield { type: "meta", request_id: rid };
}

export async function completeGoogleGemini(env: Env, req: ChatRequest): Promise<{ text: string; request_id: string; usage: Record<string, number> }> {
  const { url, body } = buildPayload(env, req, false);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(friendlyUpstreamError(res.status, text.slice(0, 200)));
  }
  const data = await res.json<any>();
  let text = "";
  for (const cand of data.candidates || []) {
    for (const part of cand.content?.parts || []) text += part.text || "";
  }
  const u = data.usageMetadata || {};
  return {
    text,
    request_id: res.headers.get("x-request-id") || String(data.responseId || ""),
    usage: {
      prompt_tokens: Number(u.promptTokenCount || 0),
      completion_tokens: Number(u.candidatesTokenCount || 0),
      total_tokens: Number(u.totalTokenCount || 0),
    },
  };
}
