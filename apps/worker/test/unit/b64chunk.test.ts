/** 分块 base64 解码器:与 atob 交叉验证、切片一致性、padding、非法字符。 */
import { describe, it, expect } from "vitest";
import { decodeBase64Into, b64DecodedLength, countTailPadding, referenceAtobDecode, Base64DecodeError } from "../../src/providers/b64chunk";

function randomBytes(n: number, seed = 42): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s & 0xff;
  }
  return out;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

describe("decodeBase64Into", () => {
  it.each([0, 1, 2, 3, 300, 4096, 100_000])("与 atob 一致(length=%i)", (n) => {
    const bytes = randomBytes(n);
    const b64 = toB64(bytes);
    const out = new Uint8Array(b64DecodedLength(b64.length, countTailPadding(b64.slice(-8))));
    const written = decodeBase64Into(b64, 0, b64.length, out);
    expect(written).toBe(n);
    expect(out).toEqual(bytes);
  });

  it("4 字符对齐切片串行解码 == 整体解码(大图分块路径的数学基础)", () => {
    const bytes = randomBytes(3 * 1024 * 1024 + 1); // 3MB+1 → padding=2
    const b64 = toB64(bytes);
    const SLICE = 4 * 1024 * 1024; // 4M 字符对齐
    const pad = countTailPadding(b64.slice(-8));
    const out = new Uint8Array(b64DecodedLength(b64.length, pad));
    let offset = 0;
    for (let start = 0; start < b64.length; start += SLICE) {
      const end = Math.min(start + SLICE, b64.length);
      offset += decodeBase64Into(b64, start, end, out.subarray(offset));
    }
    expect(offset).toBe(bytes.length);
    expect(out).toEqual(bytes);
    expect(out).toEqual(referenceAtobDecode(b64));
  });

  it("padding 统计与解码长度", () => {
    expect(countTailPadding("ab==")).toBe(2);
    expect(countTailPadding("abc=")).toBe(1);
    expect(countTailPadding("abcd")).toBe(0);
    // 3n 字节 → b64 无 padding
    expect(b64DecodedLength(4, 0)).toBe(3);
    expect(b64DecodedLength(8, 2)).toBe(4);
  });

  it("非法字符抛错", () => {
    const out = new Uint8Array(16);
    expect(() => decodeBase64Into("!!!!", 0, 4, out)).toThrow(Base64DecodeError);
    // 末段 padding 后的非法字符在 '=' 处停即安全
    expect(() => decodeBase64Into("ab==", 0, 4, out)).not.toThrow();
  });
});
