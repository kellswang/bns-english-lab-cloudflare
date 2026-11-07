/**
 * 本地 mock 图像/对话上游 —— 真实 HTTP 服务器(127.0.0.1 随机端口)。
 * 取代 vi.stubGlobal("fetch"):避免与 miniflare 绑定 RPC 的全局 fetch 相互干扰,
 * 且让交付链路(下载/分块/content-length 有无)走真实网络语义。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

export interface MockUpstream {
  url: string;
  close: () => Promise<void>;
  /** 设置下一次 /images/* 请求的响应(JSON 对象或原始体) */
  setNextImageResponse: (body: unknown | ((req: IncomingMessage) => { status: number; body: unknown; headers?: Record<string, string> })) => void;
  /** 注册一个可下载文件(路径、字节、是否带 content-length) */
  addFile: (path: string, bytes: Uint8Array, opts?: { contentType?: string; noContentLength?: boolean }) => void;
  /** 计数:上游被调用次数 */
  calls: { images: number; files: number };
  reset: () => void;
}

export async function startMockUpstream(): Promise<MockUpstream> {
  const state: {
    nextImage: MockUpstream["setNextImageResponse"] extends (f: infer T) => void ? T | null : never;
    files: Map<string, { bytes: Uint8Array; contentType: string; noContentLength: boolean }>;
    calls: { images: number; files: number };
  } = {
    nextImage: null,
    files: new Map(),
    calls: { images: 0, files: 0 },
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || "/";
    if (url.startsWith("/v1/images/")) {
      state.calls.images++;
      // 消费请求体
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const next = state.nextImage;
        if (typeof next === "function") {
          const r = next(req);
          const headers = { "content-type": "application/json", "x-request-id": "mock-rid", ...(r.headers || {}) };
          res.writeHead(r.status, headers);
          res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
        } else if (next !== null && next !== undefined) {
          res.writeHead(200, { "content-type": "application/json", "x-request-id": "mock-rid" });
          res.end(JSON.stringify(next));
        } else {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "mock: no response configured" } }));
        }
      });
      return;
    }
    const fileMatch = /^\/files\/(.+)$/.exec(url);
    if (fileMatch) {
      state.calls.files++;
      const f = state.files.get("/files/" + fileMatch[1]);
      if (!f) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const headers: Record<string, string> = { "content-type": f.contentType };
      if (!f.noContentLength) headers["content-length"] = String(f.bytes.byteLength);
      res.writeHead(200, headers);
      res.end(Buffer.from(f.bytes));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 8791;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    setNextImageResponse: (body) => { state.nextImage = body as never; },
    addFile: (path, bytes, opts) => {
      state.files.set(path, { bytes, contentType: opts?.contentType || "image/png", noContentLength: opts?.noContentLength ?? false });
    },
    calls: state.calls,
    reset: () => {
      state.nextImage = null;
      state.files.clear();
      // 原地清零:外部持有的是同一引用,不能换新对象
      state.calls.images = 0;
      state.calls.files = 0;
    },
  };
}
