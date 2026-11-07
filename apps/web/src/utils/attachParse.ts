/**
 * 浏览器端附件解析(P1:AI 能真正读到上传文档的正文)。
 * - PDF:pdfjs-dist 逐页抽文本(≤60 页、≤60,000 字符,超限如实标记)
 * - DOCX:mammoth 抽纯文本(含表格的段落)
 * - TXT/MD/CSV/JSON:直接读取
 * - 图片:canvas 重编码为 PNG —— EXIF/GPS 等元数据不会离开浏览器;
 *   对话附件按模型输入要求把长边缩到 ≤1568px(参考图不缩,保持原分辨率)
 * 解析失败的错误必须可读,绝不上传"成功但 AI 读不到"的附件。
 */
export const MAX_TEXT_CHARS = 60_000;
export const PDF_MAX_PAGES = 60;
export const CHAT_IMAGE_MAX_EDGE = 1568;
export const MAX_REFERENCE_PIXELS = 24_000_000; // 浏览器 canvas 安全上限(iOS ≈16.7MP)

export interface ClientParseResult {
  blob: Blob;
  contentType: string;
  extractedText: string | null;
  pageCount: number | null;
  textTruncated: boolean;
}

export class ParseError extends Error {}

function sniffKind(file: File, head: Uint8Array): "image" | "pdf" | "docx" | "text" {
  if (head[0] === 0x89 && head[1] === 0x50) return "image";
  if (head[0] === 0xff && head[1] === 0xd8) return "image";
  if (head[0] === 0x52 && head[1] === 0x49 && head[8] === 0x57) return "image";
  if (head[0] === 0x25 && head[1] === 0x50) return "pdf";
  if (head[0] === 0x50 && head[1] === 0x4b) return "docx";
  if (/\.(txt|md|csv|json)$/i.test(file.name)) return "text";
  return "text";
}

async function extractPdf(file: File): Promise<ClientParseResult> {
  const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = Math.min(doc.numPages, PDF_MAX_PAGES);
  let text = "";
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const item of content.items as Array<{ str?: string }>) {
      if (item.str) text += item.str + (item.str.endsWith(" ") ? "" : " ");
    }
    text += "\n";
    if (text.length > MAX_TEXT_CHARS) break;
  }
  const truncated = doc.numPages > PDF_MAX_PAGES || text.length > MAX_TEXT_CHARS;
  return {
    blob: file,
    contentType: "application/pdf",
    extractedText: text.trim().length ? text.slice(0, MAX_TEXT_CHARS) : null,
    pageCount: doc.numPages,
    textTruncated: truncated,
  };
}

async function extractDocx(file: File): Promise<ClientParseResult> {
  const mammoth = await import("mammoth/mammoth.browser");
  const buf = await file.arrayBuffer();
  const result = await (mammoth as any).extractRawText({ arrayBuffer: buf });
  let text = String(result?.value || "");
  const truncated = text.length > MAX_TEXT_CHARS;
  return {
    blob: file,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extractedText: text.trim().length ? text.slice(0, MAX_TEXT_CHARS) : null,
    pageCount: null,
    textTruncated: truncated,
  };
}

async function extractText(file: File): Promise<ClientParseResult> {
  let text = await file.text();
  const truncated = text.length > MAX_TEXT_CHARS;
  return {
    blob: file,
    contentType: "text/plain; charset=utf-8",
    extractedText: text.slice(0, MAX_TEXT_CHARS),
    pageCount: null,
    textTruncated: truncated,
  };
}

/** 图片经 canvas 重编码(去 EXIF/GPS);chat 附件缩到长边 ≤1568。 */
async function reencodeImage(file: File, maxEdge: number | null): Promise<ClientParseResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ParseError("图片无法解码,请换一张图片");
  }
  try {
    const pixels = bitmap.width * bitmap.height;
    if (maxEdge === null && pixels > MAX_REFERENCE_PIXELS) {
      throw new ParseError(`图片像素过大(${bitmap.width}×${bitmap.height}),浏览器处理不了,请缩小后再上传`);
    }
    let w = bitmap.width;
    let h = bitmap.height;
    if (maxEdge && Math.max(w, h) > maxEdge) {
      const scale = maxEdge / Math.max(w, h);
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
    }
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new ParseError("浏览器 canvas 不可用,无法处理图片");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new ParseError("图片重编码失败,请重试");
    return { blob, contentType: "image/png", extractedText: null, pageCount: null, textTruncated: false };
  } finally {
    bitmap.close?.();
  }
}

/** 统一入口:返回处理后的 blob 与元数据。 */
export async function parseFileForUpload(file: File, usage: "chat" | "reference"): Promise<ClientParseResult> {
  const headBuf = await file.slice(0, 16).arrayBuffer();
  const kind = sniffKind(file, new Uint8Array(headBuf));

  if (kind === "image") {
    if (usage === "chat") return reencodeImage(file, CHAT_IMAGE_MAX_EDGE);
    return reencodeImage(file, null);
  }
  if (usage === "reference") {
    throw new ParseError("参考图只支持 PNG / JPEG / WebP 图片");
  }
  if (kind === "pdf") return extractPdf(file);
  if (kind === "docx") return extractDocx(file);
  return extractText(file);
}
