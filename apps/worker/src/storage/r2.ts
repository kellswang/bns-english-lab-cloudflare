/**
 * R2 存储层 —— 替代原项目 data/ 本地磁盘。
 * 键约定(不含姓名/邮箱等个人资料,只用随机 ID):
 *   versions/{projectId}/{versionId}/original.png   原图(正式作品,永久保留)
 *   versions/{projectId}/{versionId}/thumb.jpg      缩略图(可选)
 *   uploads/{projectId}/{uploadId}.png              参考图
 *   attachments/{conversationId}/{attachmentId}     对话附件原始文件
 *   extracted/{attachmentId}.txt                    大文档抽取正文(超长时)
 */
import type { Env } from "../types";

export const R2Keys = {
  versionOriginal: (projectId: string, versionId: string, ext = "png") =>
    `versions/${projectId}/${versionId}/original.${ext}`,
  versionThumb: (projectId: string, versionId: string) =>
    `versions/${projectId}/${versionId}/thumb.jpg`,
  upload: (projectId: string, uploadId: string, ext = "png") =>
    `uploads/${projectId}/${uploadId}.${ext}`,
  attachment: (conversationId: string, attachmentId: string) =>
    `attachments/${conversationId}/${attachmentId}`,
  extractedText: (attachmentId: string) => `extracted/${attachmentId}.txt`,
};

export async function putObject(
  env: Env,
  key: string,
  data: ArrayBuffer | Uint8Array | ReadableStream,
  contentType: string,
  opts: { length?: number } = {},
): Promise<R2Object> {
  const httpMetadata: R2HTTPMetadata = { contentType };
  if (data instanceof ReadableStream) {
    // R2 对流的写入需要已知长度:用 FixedLengthStream 包一层
    if (!opts.length) throw new Error("ReadableStream 上传必须提供 length(FixedLengthStream)");
    const fixed = new FixedLengthStream(opts.length);
    data.pipeTo(fixed.writable).catch(() => {});
    return env.MEDIA.put(key, fixed.readable, { httpMetadata });
  }
  const value = data instanceof Uint8Array
    ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    : data;
  return env.MEDIA.put(key, value, { httpMetadata });
}

export async function getObject(env: Env, key: string): Promise<R2ObjectBody | null> {
  return env.MEDIA.get(key);
}

/** 校验文件魔数,防止把 HTML/脚本伪装成图片写进 R2。 */
export function sniffImageMime(head: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | null {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) {
    return "image/png";
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 12 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return "image/webp";
  return null;
}

export function sniffDocMime(head: Uint8Array, filename: string): "pdf" | "docx" | "text" | null {
  if (head.length >= 5 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf";
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) {
    return /\.docx$/i.test(filename) ? "docx" : null; // zip 魔数必须配合扩展名与内容校验
  }
  return null;
}

const SAFE_DISPOSITION = /["\\/:*?"<>|\r\n]/g;

/** 下载响应:防 MIME 嗅探、防内嵌 HTML。 */
export function fileResponse(
  body: ReadableStream | ArrayBuffer,
  contentType: string,
  opts: { filename?: string; cache?: string; len?: number } = {},
): Response {
  const headers: Record<string, string> = {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "cache-control": opts.cache || "private, max-age=3600",
  };
  if (opts.filename) {
    const ascii = opts.filename.replace(SAFE_DISPOSITION, "_");
    headers["content-disposition"] =
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(opts.filename)}`;
  }
  if (opts.len !== undefined) headers["content-length"] = String(opts.len);
  return new Response(body as BodyInit, { headers });
}
