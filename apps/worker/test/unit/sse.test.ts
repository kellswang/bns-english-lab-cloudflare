/** SSE 解析:跨 chunk UTF-8 多字节、半截行、[DONE] 哨兵。 */
import { describe, it, expect } from "vitest";
import { SseLineReader } from "../../src/chat/providers/base";

function encoder(): TextEncoder {
  return new TextEncoder();
}

describe("SseLineReader", () => {
  it("完整行解析", () => {
    const sse = new SseLineReader();
    const lines = sse.push(encoder().encode('data: {"a":1}\ndata: [DONE]\n'));
    expect(lines).toEqual(['data: {"a":1}', "data: [DONE]"]);
  });

  it("半截行跨 chunk 保持", () => {
    const sse = new SseLineReader();
    const enc = encoder();
    const a = sse.push(enc.encode('data: {"text":"你'));
    expect(a).toEqual([]);
    const b = sse.push(enc.encode('好"}\n'));
    expect(b).toEqual(['data: {"text":"你好"}']);
  });

  it("UTF-8 多字节字符被 chunk 切开也不乱码", () => {
    const sse = new SseLineReader();
    const enc = encoder();
    const full = enc.encode('data: {"t":"英语教学🎨🎨"}\n');
    // 从任意字节处切开
    const mid = 12;
    const part1 = sse.push(full.slice(0, mid));
    const part2 = sse.push(full.slice(mid));
    const all = [...part1, ...part2].join("\n");
    expect(all).toContain("英语教学🎨🎨");
  });

  it("flush 输出未终止的尾巴", () => {
    const sse = new SseLineReader();
    sse.push(encoder().encode("data: tail"));
    expect(sse.flush()).toEqual(["data: tail"]);
  });
});
