/**
 * 图像网关 —— 捕获式 API(P0:与 imgpipe 配合,单次调用不处理整图)。
 *
 * startImageUpstream:发起上游请求,把响应体**原样管道透传**到 R2
 * (content-length 已知 → 单对象;未知 → 分块对象)。CPU≈纯 I/O。
 * 元数据提取、b64 抽取、解码全部移到后续队列阶段(见 imageConsumer)。
 *
 * 语义与原 image_provider.py 一致:超时/断连/5xx → uncertain;
 * request_id 以响应头 x-request-id 为准;错误信息中文可读。
 */
import type { Env } from "../types";
import { RAW_CAPTURE_CHUNK, writeStreamToChunks } from "./imgpipe";
import { sniffImageMime } from "../storage/r2";

export class ImageProviderError extends Error {
  constructor(message: string, public uncertain = false) {
    super(message);
  }
}

export interface UpstreamCapture {
  requestId: string | null;
  /** 响应体分块对象:prefix/0..n-1 */
  capture: { kind: "chunks"; prefix: string; chunks: number; total: number };
}

const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;

function friendly(status: number, message: string): ImageProviderError {
  if (status === 401 || status === 403) return new ImageProviderError("图像服务凭据无效,请联系管理员");
  if (status === 402) return new ImageProviderError("图像服务余额不足,请联系管理员充值");
  if (status === 429) return new ImageProviderError("图像服务繁忙,请稍后再试");
  return new ImageProviderError(message || `图像服务返回 ${status},请稍后重试`, status >= 500);
}

export async function callImageUpstream(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<{ res: Response; requestId: string | null }> {
  let res: Response;
  try {
    // 与原 image_provider._post_json 一致:{AI_BASE_URL 去尾斜杠}{path}
    res = await fetch(env.AI_BASE_URL.replace(/\/+$/, "") + path, init);
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ImageProviderError(
      timeout ? "图像服务响应超时/连接中断,本次结果待确认,请勿重复提交" : "图像服务连接失败,请稍后重试",
      timeout,
    );
  }
  const requestId = res.headers.get("x-request-id") || res.headers.get("request-id");
  if (res.status >= 400) {
    let message = "";
    try {
      const err = (await res.json() as any).error;
      message = typeof err === "object" && err ? String(err.message || "") : String(err || "");
    } catch { message = ""; }
    throw friendly(res.status, message);
  }
  if (!res.body) throw new ImageProviderError("图像服务返回了空响应");
  return { res, requestId };
}

/** 发起上游请求并把响应体透传到 R2;统一使用分块对象(跨环境可移植),总量 64MB 上限。 */
export async function startImageUpstream(
  env: Env,
  opts: { path: string; init: RequestInit; rawPrefix: string },
): Promise<UpstreamCapture> {
  const { res, requestId } = await callImageUpstream(env, opts.path, opts.init);
  const out = await writeStreamToChunks(env, opts.rawPrefix, res.body!, RAW_CAPTURE_CHUNK, {
    totalCap: 64 * 1024 * 1024,
  });
  return { requestId, capture: { kind: "chunks", prefix: out.prefix, chunks: out.chunks, total: out.total } };
}

export function buildEditFormData(opts: { model: string; prompt: string; requested: string; sources: Array<{ filename: string; mime: string; data: ArrayBuffer }> }): FormData {
  const fd = new FormData();
  fd.append("model", opts.model);
  fd.append("prompt", opts.prompt);
  fd.append("n", "1");
  fd.append("size", opts.requested);
  fd.append("quality", "high");
  for (const s of opts.sources) {
    fd.append(opts.sources.length === 1 ? "image" : "image[]", new Blob([s.data], { type: s.mime }), s.filename);
  }
  return fd;
}

/** URL 白名单:与图像 API **同源**(协议+主机+端口)才允许,杜绝 SSRF。 */
export function allowedImageUrl(env: Env, raw: string): string | null {
  try {
    const u = new URL(raw);
    const base = new URL(env.AI_BASE_URL);
    if (u.protocol !== base.protocol) return null;
    if (u.host !== base.host) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** url 模式交付:流式 → 分块对象(纯 I/O);首块嗅探魔数。 */
export async function captureUrlToChunks(env: Env, url: string, prefix: string): Promise<{ chunks: number; total: number; mime: string }> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ImageProviderError("图片下载地址不可访问", true);
  }
  if (!res.ok || res.status >= 300 || !res.body) throw new ImageProviderError("图片下载地址不可用", true);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_REMOTE_IMAGE_BYTES) throw new ImageProviderError("图片下载地址文件过大");
  const reader = res.body.getReader();
  let first = true;
  let mime = "image/png";
  const tee = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      if (first && value) {
        first = false;
        const sniff = sniffImageMime(value.subarray(0, 16));
        if (!sniff) { controller.error(new ImageProviderError("上游返回的内容不是可识别的图片")); return; }
        mime = sniff;
      }
      if (value) controller.enqueue(value);
    },
  });
  // P0.5:无 Content-Length 也在流式读取中强制 25MB 上限
  const out = await writeStreamToChunks(env, prefix, tee, RAW_CAPTURE_CHUNK, {
    totalCap: MAX_REMOTE_IMAGE_BYTES,
  });
  return { chunks: out.chunks, total: out.total, mime };
}

/** 从已解码/下载字节读取 PNG 或 JPEG 的像素尺寸(不完整解码)。 */
export function readImageDims(head: Uint8Array): { width: number; height: number } | null {
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50) {
    const view = new DataView(head.buffer, head.byteOffset);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (head.length >= 4 && head[0] === 0xff && head[1] === 0xd8) {
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let i = 2;
    while (i + 9 < head.length) {
      if (view.getUint8(i) !== 0xff) { i++; continue; }
      const marker = view.getUint8(i + 1);
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
      }
      const len = view.getUint16(i + 2);
      i += 2 + len;
    }
  }
  return null;
}

/** base64 文本 → 字节(atob 原生解码 + 定长转换;单次调用 ≤ 数 ms)。 */
export function decodeAsciiB64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
