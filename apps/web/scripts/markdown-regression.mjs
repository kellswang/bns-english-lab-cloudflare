// Markdown 渲染安全回归：jsdom + DOMPurify + KaTeX 全链路。
// 用法：npm run test:markdown（先经 esbuild 打包 src/utils/markdown.ts）
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
const { renderMarkdown } = await import('../.mdtest-lib.mjs')

let fail = 0
function check(name, ok, out) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) { fail++; console.log('  ->', String(out).slice(0, 200)) }
}

let out = renderMarkdown('[点我](javascript:alert(1))')
check('javascript: 链接被移除', !/javascript:/i.test(out), out)

out = renderMarkdown('![泄漏](http://evil.com/x.png)')
check('外部图片不自动加载', !/src="http:\/\//.test(out), out)
check('外部图片有占位说明', /外部图片已屏蔽/.test(out), out)

out = renderMarkdown('$x^2$ 与 $$\frac{1}{2}$$')
check('数学公式渲染', /katex/.test(out), out)
check('数学输出不含注入', !/<script|onerror/i.test(out), out)

out = renderMarkdown('<img src=x onerror=alert(1)>')
check('内联事件被清除', !/onerror/.test(out), out)

out = renderMarkdown('[正常](https://example.com)')
check('正常链接保留', /https:\/\/example\.com/.test(out), out)
check('链接带 noopener', /noopener/.test(out), out)

out = renderMarkdown('[data](data:text/html,<script>alert(1)</script>)')
check('data: 链接被移除', !/data:text\/html/.test(out), out)

if (fail) { console.error(`\n${fail} 项失败`); process.exit(1) }
console.log('\n全部通过')
