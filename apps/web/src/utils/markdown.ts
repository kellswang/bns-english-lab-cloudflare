import DOMPurify from 'dompurify'
import katex from 'katex'
import { marked } from 'marked'
import 'katex/dist/katex.min.css'

marked.setOptions({ gfm: true, breaks: true })

// 链接统一新窗口 + noopener；外部图片不自动加载（模型输出里的远程图
// 可能让浏览器向第三方泄漏访问信息），换成可点击的占位说明。
let _hooked = false
function ensurePurifyHook(): void {
  if (_hooked || typeof DOMPurify.addHook !== 'function') return
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as unknown as Element
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || ''
      if (/^(https?:)?\/\//i.test(src) || /^\/\//.test(src)) {
        const a = el.ownerDocument.createElement('a')
        a.setAttribute('href', src)
        a.setAttribute('target', '_blank')
        a.setAttribute('rel', 'noopener noreferrer')
        a.setAttribute('class', 'ext-img-blocked')
        a.textContent = `[外部图片已屏蔽：${(el.getAttribute('alt') || src).slice(0, 80)}]`
        el.replaceWith(a)
      }
    }
  })
  _hooked = true
}

/** 先把 $$…$$ / $…$ / \(…\) 抽出来用 KaTeX 渲染，再走 Markdown，避免公式被当成强调语法。
 *
 * 占位符必须能活着穿过 marked + DOMPurify：控制字符（如 \u0000）会被
 * DOMPurify 清掉导致公式还原失败，这里用带 data 属性的空 <span>。
 */
function renderMath(src: string): { text: string; blocks: string[] } {
  const blocks: string[] = []
  const stash = (html: string) => {
    blocks.push(html)
    return `<span data-math-stash="${blocks.length - 1}"></span>`
  }
  let out = src.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex) => {
    try {
      return stash(katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }))
    } catch { return _m }
  })
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex) => {
    try {
      return stash(katex.renderToString(tex.trim(), { displayMode: true, throwOnError: false }))
    } catch { return _m }
  })
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex) => {
    try {
      return stash(katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }))
    } catch { return _m }
  })
  out = out.replace(/(^|[^\\$])\$([^\n$]{1,200}?)\$/g, (m, pre, tex) => {
    if (!/[\\^_{}=]/.test(tex)) return m
    try {
      return pre + stash(katex.renderToString(tex.trim(), { displayMode: false, throwOnError: false }))
    } catch { return m }
  })
  return { text: out, blocks }
}

export function renderMarkdown(src: string): string {
  if (!src) return ''
  ensurePurifyHook()
  const { text, blocks } = renderMath(src)
  const html = marked.parse(text, { async: false }) as string
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'],
  })
  return clean.replace(/<span data-math-stash="(\d+)"[^>]*><\/span>/g,
                       (_m, i) => blocks[Number(i)] || '')
}

/** 代码块右上角补一个复制按钮所需的语言标注 */
export function plainText(src: string): string {
  return src.replace(/```[\s\S]*?```/g, '[代码块]').slice(0, 400)
}
