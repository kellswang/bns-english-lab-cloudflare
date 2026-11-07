/** 统一 API 客户端：httpOnly Cookie 会话，错误统一抛 ApiError。 */
export class ApiError extends Error {
  status: number
  detail: any
  headers: Record<string, string>
  constructor(status: number, detail: any, headers: Record<string, string> = {}) {
    super(typeof detail === 'string' ? detail : detail?.message || detail?.detail?.message || `请求失败 (${status})`)
    this.status = status
    this.detail = detail
    this.headers = headers
  }
  get retryAfter(): number {
    const v = Number(this.headers['retry-after'])
    return Number.isFinite(v) && v > 0 ? v : 0
  }
}

async function request<T>(method: string, url: string, body?: unknown, form?: FormData): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(url, {
    method,
    headers,
    credentials: 'same-origin',
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: any = null
  if (text) {
    try { data = JSON.parse(text) } catch { data = text }
  }
  if (!res.ok) {
    const h: Record<string, string> = {}
    res.headers.forEach((v, k) => { h[k.toLowerCase()] = v })
    throw new ApiError(res.status, data?.detail ?? data ?? `HTTP ${res.status}`, h)
  }
  return data as T
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
  upload: <T>(url: string, form: FormData) => request<T>('POST', url, undefined, form),
}
