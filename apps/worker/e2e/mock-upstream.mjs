// E2E 用本地 mock 上游:固定端口 8791;生图返回小 PNG;对话返回 SSE(不用于 chat mock)
import { createServer } from "node:http";

function pngBytes(size) {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, 2048); view.setUint32(20, 1152);
  let s = 7;
  for (let i = 24; i < size; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; bytes[i] = s & 0xff; }
  return bytes;
}
const PNG = pngBytes(150_000);
const B64 = Buffer.from(PNG).toString("base64");

createServer((req, res) => {
  const url = req.url || "/";
  if (url.startsWith("/v1/images/")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "x-request-id": "e2e-rid" });
      res.end(JSON.stringify({ data: [{ b64_json: B64, revised_prompt: "E2E mock 图" }], size: "2048x1152", output_format: "png", usage: { output_tokens: 1 } }));
    });
    return;
  }
  if (url.startsWith("/v1/responses")) {
    // OpenAI Responses 协议的 SSE mock(对话)
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "x-request-id": "e2e-chat-rid" });
      const frames = [
        'data: {"type":"response.created","response":{"id":"resp_e2e","model":"gpt-6.1-sol"}}',
        'data: {"type":"response.output_text.delta","delta":"这是"}',
        'data: {"type":"response.output_text.delta","delta":"E2E mock 回答。"}',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":4,"total_tokens":14}}}',
        "data: [DONE]",
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i < frames.length) { res.write(frames[i] + "\n\n"); i++; }
        else { clearInterval(timer); res.end(); }
      }, 120);
    });
    return;
  }
  res.writeHead(404); res.end("not found");
}).listen(8791, "0.0.0.0", () => console.log("E2E mock upstream on http://127.0.0.1:8791"));
