/**
 * 分块 base64 解码 —— P0 核心:避免整张图 base64 与解码字节同时驻留内存。
 *
 * 设计目标(Cloudflare Free,10ms CPU/调用):
 * - 每次调用只解码一个有限切片(slice),由队列跨调用串起整图;
 * - 查表解码直接写入预分配 Uint8Array,不经过 binary-string 中转;
 * - 切片长度按 4 字符对齐,避免跨切片余数(除末尾 padding)。
 */

const B64_REVERSE = new Int16Array(256).fill(-1);
{
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < A.length; i++) B64_REVERSE[A.charCodeAt(i)] = i;
}

export class Base64DecodeError extends Error {}

/**
 * 把 src 的 [start, end) 区间(须 4 字符对齐;末段可含 padding)解码到 out 的偏移 0 起。
 * 返回写入字节数。遇到非法字符抛 Base64DecodeError。
 */
export function decodeBase64Into(src: string, start: number, end: number, out: Uint8Array): number {
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = start; i < end; i++) {
    const v = B64_REVERSE[src.charCodeAt(i) & 0xff]!;
    if (v < 0) {
      const ch = src[i];
      if (ch === "=") break; // padding:本轮结束(仅允许出现在末段)
      if (ch === "\n" || ch === "\r" || ch === " ") continue;
      throw new Base64DecodeError(`非法 base64 字符 ${JSON.stringify(ch)} @${i}`);
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return o;
}

/** 计算 base64 文本解码后的字节长度(考虑 padding)。 */
export function b64DecodedLength(b64Len: number, tailPadding: number): number {
  // 每 4 字符 3 字节;末组 pad 数决定扣减
  return Math.floor(b64Len / 4) * 3 - tailPadding;
}

/** 统计字符串末尾的 '=' 数(仅扫尾部一小段)。 */
export function countTailPadding(tail: string): number {
  let n = 0;
  for (let i = tail.length - 1; i >= 0 && tail[i] === "="; i--) n++;
  return n > 2 ? 2 : n;
}

/** 与 atob 交叉验证用的小工具(测试)。 */
export function referenceAtobDecode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
