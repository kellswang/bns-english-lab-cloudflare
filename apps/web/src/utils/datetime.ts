/**
 * 后端数据库统一存 naive UTC（见 app/db.py 的 utcnow），接口返回的 ISO 字符串不带时区。
 * 前端如果直接 new Date(iso)，浏览器会按本地时区解析，等于把 UTC 当成本地时间，
 * 结果整整差 8 小时（操作日志、最近登录时间、作品时间都受影响）。
 * 这里统一：先按 UTC 解析，再固定按东八区格式化输出。
 */
const ZONE = 'Asia/Shanghai'

/** 把后端时间解析成毫秒时间戳；已带时区的字符串原样解析。 */
export function parseServerTime(iso?: string | null): number {
  if (!iso) return NaN
  const s = iso.trim()
  if (!s) return NaN
  const hasZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(s)
  return Date.parse(hasZone ? s : `${s}Z`)
}

const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

/** 东八区的年月日时分（固定时区，不受电脑本地时区影响）。 */
export function beijingParts(iso?: string | null): Record<string, string> | null {
  const t = parseServerTime(iso)
  if (!Number.isFinite(t)) return null
  const out: Record<string, string> = {}
  for (const p of FMT.formatToParts(new Date(t))) {
    if (p.type !== 'literal') out[p.type] = p.value
  }
  return out
}

/** 默认「MM-DD HH:mm」；传 year 得「YYYY-MM-DD HH:mm」，传 seconds 再补秒。 */
export function fmtDateTime(
  iso?: string | null,
  opts: { year?: boolean; seconds?: boolean } = {},
): string {
  const p = beijingParts(iso)
  if (!p) return '—'
  const md = `${p.month}-${p.day}`
  const date = opts.year ? `${p.year}-${md}` : md
  const time = opts.seconds
    ? `${p.hour}:${p.minute}:${p.second}`
    : `${p.hour}:${p.minute}`
  return `${date} ${time}`
}
