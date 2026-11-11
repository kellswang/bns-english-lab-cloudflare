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

/** 默认 20 秒：登录发码/验证这类短请求卡住时必须能失败退出，
 *  否则按钮会一直停在「正在验证…」，用户以为死机。上传单独放宽。
 *  流式对话与图片二进制读取各自独立实现，不走这里。 */
const DEFAULT_TIMEOUT_MS = 20000

async function request<T>(method: string, url: string, body?: unknown, form?: FormData,
                          timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'XMLHttpRequest' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    })
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      throw new ApiError(0, '网络响应超时，请检查网络后重试', {})
    }
    throw new ApiError(0, '网络连接失败，请检查网络后重试', {})
  } finally {
    window.clearTimeout(timer)
  }
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
  upload: <T>(url: string, form: FormData) => request<T>('POST', url, undefined, form, 180000),
}
