/**
 * P1.2:流式扫描的元数据恢复测试。
 * 断言大 b64 被剥离后,重建 JSON 能完整恢复 revised_prompt / size / usage /
 * output_format 及上游其它业务字段 —— 字段顺序、多余字段、跨窗口切分均覆盖。
 */
import { describe, it, expect } from "vitest";
import { newScanState, scanWindow, finishScan, SCAN_WINDOW_BYTES } from "../../src/providers/imgpipe";

function makeMedia() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    env: {
      MEDIA: {
        async put(key: string, value: Uint8Array) { store.set(key, value); return { key } as never; },
        async get(key: string) {
          const v = store.get(key);
          return v ? { arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) } : null;
        },
      },
    },
  };
}

function pngBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47], 0);
  let s = 5;
  for (let i = 8; i < n; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; b[i] = s & 0xff; }
  return b;
}
function toB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function runScan(media: ReturnType<typeof makeMedia>, body: string, win: number | "byte") {
  const st = newScanState("tmp/b64/x");
  const enc = new TextEncoder();
  if (win === "byte") {
    for (let i = 0; i < body.length; i++) {
      await scanWindow(media.env as any, st, enc.encode(body[i]!), i === body.length - 1);
    }
  } else {
    const raw = enc.encode(body);
    for (let i = 0; i < raw.length; i += win) {
      const isLast = i + win >= raw.length;
      await scanWindow(media.env as any, st, raw.subarray(i, Math.min(i + win, raw.length)), isLast);
    }
  }
  return finishScan(media.env as any, st);
}

describe("scan 元数据恢复(P1.2)", () => {
  const png = pngBytes(3_000);
  const b64 = toB64(png);
  const body = JSON.stringify({
    created: 1762490000,
    data: [{ b64_json: b64, revised_prompt: "一只戴眼镜的猫头鹰老师" }],
    size: "2048x1152",
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    output_format: "png",
  });

  it("单窗口:全部元数据字段完整恢复", async () => {
    const m = makeMedia();
    const fin = await runScan(m, body, 4 * 1024 * 1024);
    expect(fin.b64Bytes).toBe(b64.length);
    expect(fin.tailPadding).toBe(0);
    expect(fin.payload.size).toBe("2048x1152");
    expect(fin.payload.output_format).toBe("png");
    expect(fin.payload.created).toBe(1762490000);
    expect(fin.payload.usage).toEqual({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    expect(fin.payload.data[0].revised_prompt).toBe("一只戴眼镜的猫头鹰老师");
    expect(fin.payload.data[0].b64_json).toBe("");
  });

  it("字段顺序颠倒 + 多余字段,仍完整恢复", async () => {
    const reordered = JSON.stringify({
      size: "2048x1152",
      extra_top: { nested: [1, 2, 3] },
      data: [{ revised_prompt: "先写提示", b64_json: b64 }],
      output_format: "png",
      usage: { input_tokens: 1 },
      trailing_extra: "ok",
    });
    const m = makeMedia();
    const fin = await runScan(m, reordered, 1024);
    expect(fin.b64Bytes).toBe(b64.length);
    expect(fin.payload.data[0].revised_prompt).toBe("先写提示");
    expect(fin.payload.extra_top).toEqual({ nested: [1, 2, 3] });
    expect(fin.payload.trailing_extra).toBe("ok");
    expect(fin.payload.usage).toEqual({ input_tokens: 1 });
  });

  it.each([1024, 512, 128])("窗口 %i 字节跨切:元数据与 b64 字节完整", async (win) => {
    const m = makeMedia();
    const fin = await runScan(m, body, win);
    expect(fin.b64Bytes).toBe(b64.length);
    expect(fin.payload.size).toBe("2048x1152");
    expect(fin.payload.usage.total_tokens).toBe(10);
    const parts: string[] = [];
    for (let i = 0; i < fin.b64Chunks; i++) {
      const v = m.store.get(`tmp/b64/x/${i}`)!;
      parts.push(new TextDecoder().decode(v));
    }
    expect(parts.join("")).toBe(b64);
  });

  it("逐字节窗口(最坏切分)不丢字节", async () => {
    const m = makeMedia();
    const fin = await runScan(m, body, "byte");
    expect(fin.b64Bytes).toBe(b64.length);
    expect(fin.payload.data[0].revised_prompt).toBe("一只戴眼镜的猫头鹰老师");
  });

  it("大图(> B64_INLINE_LIMIT)b64Bytes 准确 → staged 路径前提成立", async () => {
    const bigB64 = toB64(pngBytes(600_000));
    const bigBody = JSON.stringify({ data: [{ b64_json: bigB64 }], size: "2048x1152" });
    const m = makeMedia();
    const fin = await runScan(m, bigBody, SCAN_WINDOW_BYTES);
    expect(fin.b64Bytes).toBe(bigB64.length);
    expect(fin.b64Bytes).toBeGreaterThan(500_000);
  });
});
