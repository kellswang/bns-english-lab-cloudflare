/**
 * 图像网关适配器 —— 对应原 backend/app/image_provider.py 的上游调用部分。
 *
 * 硬约束(原样保留):
 * - supports_edit=False 的模型绝不允许 edit 路径(调用方负责 409);
 * - 超时/断连/上游 5xx → uncertain(可能已扣费),绝不自动重调付费接口;
 * - request_id 取响应头 x-request-id(对账口径);
 * - 正常路径不做任何缩放/裁切,尺寸不一致只如实记录元数据。
 *
 * Workers 差异(无 Pillow):不做像素级规范化与缩略图,改为
 *  - 校验魔数与字节数;
 *  - 上游声明尺寸与请求尺寸不一致时记录 size_mismatch 元数据,由前端如实展示;
 *  - 缩略图由浏览器端生成后经受控接口上传(见 docs/FEASIBILITY.md 闸门 A)。
 */
import type { Env } from "../types";
import { sniffImageMime } from "../storage/r2";

export class ImageProviderError extends Error {
  constructor(message: string, public uncertain = false) {
    super(message);
  }
}

export interface GeneratedImage {
  data: ArrayBuffer;
  mime: string;
  /** 上游声明尺寸(如 "2048x1440"),可能缺失 */
  upstreamSize: string | null;
  requestedSize: string;
  sizeMismatch: boolean;
  revisedPrompt: string | null;
  usage: Record<string, unknown> | null;
  requestId: string | null;
  /** 是否为 URL 模式返回(已下载) */
  source: "b64" | "url";
}

const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024;

function friendly(status: number, message: string): ImageProviderError {
  if (status === 401 || status === 403) return new ImageProviderError("图像服务凭据无效,请联系管理员");
  if (status === 402) return new ImageProviderError("图像服务余额不足,请联系管理员充值");
  if (status === 429) return new ImageProviderError("图像服务繁忙,请稍后再试");
  return new ImageProviderError(message || `图像服务返回 ${status},请稍后重试`, status >= 500);
}

interface UpstreamPayload {
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
  output_format?: string;
  size?: string;
  usage?: Record<string, unknown>;
}

/**
 * 从响应 JSON 中提取图片。两种模式:
 * - b64_json:直接 atob 到 ArrayBuffer(2K PNG 约 2-6MB,base64 字符串约 3-8MB,
 *   在 128MB 内存限制内;闸门 A 的 spike 验证 20MB 级同样可行);
 * - url:仅允许 AI_BASE_URL 同域或显式白名单域,https、不跟随重定向、25MB 上限。
 */
async function extractImage(
  env: Env,
  payload: UpstreamPayload,
): Promise<{ data: ArrayBuffer; mime: string; revised: string | null; source: "b64" | "url" }> {
  const item = payload.data?.[0];
  if (!item) throw new ImageProviderError("模型未返回图片,请稍后重试或换一个模型");

  if (item.b64_json) {
    try {
      const bin = atob(item.b64_json);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = payload.output_format && payload.output_format !== "png"
        ? `image/${payload.output_format}` : "image/png";
      return { data: bytes.buffer, mime, revised: item.revised_prompt ?? null, source: "b64" };
    } catch {
      throw new ImageProviderError("模型返回的图片数据无法解析");
    }
  }

  if (item.url) {
    const url = new URL(item.url);
    const baseHost = new URL(env.AI_BASE_URL).hostname;
    if (url.protocol !== "https:" || (url.hostname !== baseHost)) {
      throw new ImageProviderError("图片下载地址不在允许范围内");
    }
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!res.ok || res.status >= 300) throw new ImageProviderError("图片下载地址不可用", true);
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared > MAX_REMOTE_IMAGE_BYTES) throw new ImageProviderError("图片下载地址文件过大");
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_REMOTE_IMAGE_BYTES) throw new ImageProviderError("图片下载地址文件过大");
    const ct = res.headers.get("content-type")?.split(";")[0] || "image/png";
    return { data: buf, mime: ct.startsWith("image/") ? ct : "image/png", revised: item.revised_prompt ?? null, source: "url" };
  }

  throw new ImageProviderError("模型未返回图片,请稍后重试或换一个模型");
}

async function callUpstream(
  env: Env,
  path: string,
  init: RequestInit,
): Promise<{ payload: UpstreamPayload; requestId: string | null }> {
  let res: Response;
  try {
    res = await fetch(new URL(env.AI_BASE_URL).origin + path, init);
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new ImageProviderError(
      timeout
        ? "图像服务响应超时/连接中断,本次结果待确认,请勿重复提交"
        : "图像服务连接失败,请稍后重试",
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
  let payload: UpstreamPayload;
  try {
    payload = await res.json<UpstreamPayload>();
  } catch {
    throw new ImageProviderError("图像服务返回了无法解析的内容");
  }
  return { payload, requestId };
}

function multipartBody(fields: Record<string, string>, files: Array<{ name: string; filename: string; mime: string; data: ArrayBuffer }>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) {
    fd.append(f.name, new Blob([f.data], { type: f.mime }), f.filename);
  }
  return fd;
}

export async function generateImage(
  env: Env,
  opts: { model: string; prompt: string; width: number; height: number },
): Promise<GeneratedImage> {
  const requested = `${opts.width}x${opts.height}`;
  const { payload, requestId } = await callUpstream(env, "/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({
      model: opts.model,
      prompt: opts.prompt,
      n: 1,
      size: requested,
      quality: "high",
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const { data, mime, revised, source } = await extractImage(env, payload);
  const sniff = sniffImageMime(new Uint8Array(data.slice(0, 16)));
  if (!sniff) throw new ImageProviderError("上游返回的内容不是可识别的图片");
  return {
    data, mime: sniff, upstreamSize: payload.size ?? null, requestedSize: requested,
    sizeMismatch: payload.size ? payload.size !== requested : false,
    revisedPrompt: revised, usage: payload.usage ?? null, requestId, source,
  };
}

export async function editImage(
  env: Env,
  opts: { model: string; prompt: string; width: number; height: number; sources: Array<{ filename: string; mime: string; data: ArrayBuffer }> },
): Promise<GeneratedImage> {
  if (!opts.sources.length) throw new ImageProviderError("缺少源图,无法执行修改");
  const requested = `${opts.width}x${opts.height}`;
  const fields = { model: opts.model, prompt: opts.prompt, n: "1", size: requested, quality: "high" };
  const files = opts.sources.map((s, i) => ({
    name: opts.sources.length === 1 ? "image" : "image[]",
    filename: s.filename, mime: s.mime, data: s.data,
  }));
  const { payload, requestId } = await callUpstream(env, "/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${env.AI_API_KEY}` },
    body: multipartBody(fields, files),
    signal: AbortSignal.timeout(180_000),
  });
  const { data, mime, revised, source } = await extractImage(env, payload);
  const sniff = sniffImageMime(new Uint8Array(data.slice(0, 16)));
  if (!sniff) throw new ImageProviderError("上游返回的内容不是可识别的图片");
  return {
    data, mime: sniff, upstreamSize: payload.size ?? null, requestedSize: requested,
    sizeMismatch: payload.size ? payload.size !== requested : false,
    revisedPrompt: revised, usage: payload.usage ?? null, requestId, source,
  };
}
