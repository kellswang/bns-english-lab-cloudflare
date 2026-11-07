/** token 粗估 —— chat/service.py 的 estimateTokens:中文约 1 字 1 token,英文约 4 字符 1 token。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x4e00 && c <= 0x9fff) cjk++;
  }
  const other = text.length - cjk;
  return Math.trunc(cjk * 1.05 + other / 3.6) + 1;
}
