/**
 * 对话上游公共设施 —— providers/base.py 的翻译。
 * 统一事件流:{type: meta|text|usage|error|done};
 * request_id 口径三家一致:响应头 x-request-id 优先,厂商内部 id 仅兜底不覆盖。
 */
import type { ChatModelSpec } from "../capabilities";

export interface ChatMessageIn {
  role: "user" | "assistant";
  text: string;
  images: Array<{ mime: string; b64: string }>;
}

export interface ChatRequest {
  model: ChatModelSpec;
  thinking: Record<string, unknown>;
  system: string;
  messages: ChatMessageIn[];
  max_output_tokens: number;
}

export type ProviderEvent =
  | { type: "meta"; request_id: string; model?: string }
  | { type: "text"; delta: string }
  | { type: "usage"; usage: Record<string, number> }
  | { type: "error"; message: string; retryable?: boolean }
  | { type: "done"; stop_reason?: string };

export class ProviderError extends Error {
  constructor(message: string, public retryable = false) {
    super(message);
  }
}

export function chatBase(env: { CHAT_BASE_URL: string }): string {
  return (env.CHAT_BASE_URL || "").replace(/\/+$/, "");
}

export function apiRoot(env: { CHAT_BASE_URL: string }): string {
  return chatBase(env).replace(/\/v1$/, "");
}

export function authHeaders(env: { CHAT_API_KEY: string }): Record<string, string> {
  return { authorization: `Bearer ${env.CHAT_API_KEY}` };
}

export function friendlyUpstreamError(status: number, message: string): string {
  if (status === 429) return "模型服务繁忙,请稍后再试";
  if (status === 401 || status === 403) return "模型服务凭据无效,请联系管理员";
  if (status === 413) return "内容过长,请精简后重试";
  if (/model_not_available/i.test(message)) return "该模型当前不可用,请换一个模型";
  if (status >= 500) return `模型服务暂时不可用(${status}),请稍后再试`;
  return message || `模型服务返回 ${status},请稍后再试`;
}

/** 增量 SSE 行解析器:跨 chunk 的 UTF-8 多字节与半截行都安全。 */
export class SseLineReader {
  private decoder = new TextDecoder("utf-8");
  private buffer = "";

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    return lines;
  }

  flush(): string[] {
    const tail = this.buffer + this.decoder.decode();
    this.buffer = "";
    return tail ? [tail] : [];
  }
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const sse = new SseLineReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of sse.push(value)) {
        const trimmed = line.replace(/\r$/, "");
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trimStart();
          if (data === "[DONE]") return;
          yield { data };
        } else if (trimmed.startsWith("event:")) {
          yield { event: trimmed.slice(6).trim(), data: "" };
        }
        // 其它行(SSE 注释/空行)忽略
      }
    }
    for (const line of sse.flush()) {
      const trimmed = line.replace(/\r$/, "");
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trimStart();
        if (data && data !== "[DONE]") yield { data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
