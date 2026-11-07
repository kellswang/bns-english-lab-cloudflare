import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api/client'
import { parseFileForUpload, ParseError } from '../utils/attachParse'
import type { Job, MessageItem, ModelSpec, Project, SizePreset, Usage, Version } from '../types'

// P1.3:自适应轮询替代原 1.6s 固定轮询 —— 起步 3s、×1.4 退避、上限 15s,
// 页面隐藏时暂停,回到前台立即补一次;已完成即终止。
const POLL_START_MS = 3000
const POLL_MAX_MS = 15000
const POLL_BACKOFF = 1.4
const POLL_MAX_TICKS = 90   // 足够覆盖 20 分钟级生成

/** 幂等键：同一次用户操作（双击、失败后立刻重试）复用同一个值 */
function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined
  return c?.randomUUID ? c.randomUUID() : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const useWorkspace = defineStore('workspace', () => {
  const projects = ref<Project[]>([])
  const currentId = ref<string | null>(null)
  const messages = ref<MessageItem[]>([])
  const versions = ref<Version[]>([])
  const models = ref<ModelSpec[]>([])
  const defaultModel = ref('')
  const sizePresets = ref<SizePreset[]>([])
  const defaultSize = ref('a4')
  const usage = ref<Usage>({
    images: 0,
    amount_usd: 0,
    chat_amount_usd: 0,
    chat_pending: 0,
    total_usd: 0,
    unit_price_usd: 0.02,
    currency: 'USD',
    scope: 'mine',
  })
  const selectedVersionId = ref<string | null>(null)
  const jobs = ref<Record<string, Job>>({})
  const busy = ref(false)
  const loading = ref(false)
  const error = ref('')
  const search = ref('')
  /** 新建但尚未落库的创作：发出第一条请求时才创建项目，避免空记录堆在侧栏 */
  const draft = ref(false)
  /** 项目由参考图上传提前创建、标题仍是占位，首次发送时用提示词改写 */
  const autoTitled = ref(false)

  /** 正在轮询的任务（同一 id 不重复起轮询器） */
  const polling = new Set<string>()
  /** 最近一次发送：同参数的快速重试要复用幂等键，不能重复扣费 */
  let lastSend: { key: string; hash: string; at: number } | null = null

  const currentProject = computed(() => projects.value.find((p) => p.id === currentId.value) || null)
  const selectedVersion = computed(() => versions.value.find((v) => v.id === selectedVersionId.value) || null)
  const latestVersion = computed(() => versions.value[versions.value.length - 1] || null)
  const ACTIVE = ['queued', 'submitted', 'running']
  const TERMINAL = ['failed', 'uncertain', 'interrupted', 'pending_save']
  const hasActiveJob = computed(() => Object.values(jobs.value).some(
    (j) => ACTIVE.includes(j.status),
  ))
  const currentModel = computed(() => models.value.find((m) => m.id === defaultModel.value) || models.value[0])

  function downloadUrl(id: string) { return `/api/v1/versions/${id}/download` }

  async function loadModels() {
    try {
      const d = await api.get<{
        items: ModelSpec[]; default: string
        size_presets: SizePreset[]; default_size: string; quality: string
      }>('/api/v1/models')
      models.value = d.items
      defaultModel.value = d.default || d.items[0]?.id || ''
      sizePresets.value = d.size_presets || []
      defaultSize.value = d.default_size || 'a4'
    } catch { /* 由页面统一提示 */ }
  }

  async function loadUsage() {
    try { usage.value = await api.get<Usage>('/api/v1/usage') } catch { /* 保留上次数值 */ }
  }

  async function loadProjects() {
    loading.value = true
    try {
      const q = new URLSearchParams()
      if (search.value.trim()) q.set('q', search.value.trim())
      const d = await api.get<{ items: Project[] }>(`/api/v1/projects?${q}`)
      projects.value = d.items
      if (currentId.value && !d.items.some((p) => p.id === currentId.value)) {
        currentId.value = null
        messages.value = []
        versions.value = []
        selectedVersionId.value = null
      }
    } finally { loading.value = false }
  }

  async function createProject(title = '未命名创作') {
    const p = await api.post<Project>('/api/v1/projects', { title })
    projects.value.unshift(p)
    await openProject(p.id)
    return p
  }

  /** 新建创作（不落库）：与 AI 对话的「新对话」一致，发出请求才创建项目 */
  function newDraft() {
    currentId.value = null
    messages.value = []
    versions.value = []
    selectedVersionId.value = null
    jobs.value = {}
    error.value = ''
    draft.value = true
    autoTitled.value = false
  }

  /** 需要 project_id 的操作（生成 / 上传参考图）前确保项目已存在 */
  async function ensureProject(seed = ''): Promise<string> {
    if (currentId.value) return currentId.value
    const title = (seed.trim().slice(0, 40) || '未命名创作')
    const p = await api.post<Project>('/api/v1/projects', { title })
    projects.value = [p, ...projects.value.filter((x) => x.id !== p.id)]
    currentId.value = p.id
    draft.value = false
    autoTitled.value = !seed.trim()
    return p.id
  }

  async function openProject(id: string) {
    currentId.value = id
    draft.value = false
    autoTitled.value = false
    selectedVersionId.value = null
    jobs.value = {}
    error.value = ''
    await Promise.all([loadMessages(), loadVersions()])
    if (currentId.value !== id) return    // 期间用户又切了项目
    if (versions.value.length) selectedVersionId.value = versions.value[versions.value.length - 1].id
  }

  async function loadMessages() {
    const pid = currentId.value
    if (!pid) return
    const d = await api.get<{ items: MessageItem[] }>(`/api/v1/projects/${pid}/messages`)
    if (currentId.value !== pid) return   // 已经切到别的项目，丢弃旧响应
    messages.value = d.items
  }

  async function loadVersions() {
    const pid = currentId.value
    if (!pid) return
    const d = await api.get<{ items: Version[] }>(`/api/v1/projects/${pid}/versions`)
    if (currentId.value !== pid) return
    versions.value = d.items
    void ensureThumbs(pid)
  }

  // P1.2:缩略图浏览器端生成 —— 服务端不做像素处理(免费 CPU 约束)。
  // 只处理 has_thumb=false 的版本,每次最多补 8 张,生成 420px JPEG 后 PUT 回服务端。
  const thumbQueue = new Set<string>()
  async function ensureThumbs(pid: string) {
    const need = versions.value.filter((v) => !v.has_thumb && !thumbQueue.has(v.id)).slice(0, 8)
    for (const v of need) {
      thumbQueue.add(v.id)
      try {
        const res = await fetch(`/api/v1/versions/${v.id}/image`, { credentials: 'same-origin' })
        if (!res.ok) continue
        const blob = await res.blob()
        const bitmap = await createImageBitmap(blob)
        try {
          const w = Math.min(420, bitmap.width)
          const h = Math.round(bitmap.height * (w / bitmap.width))
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          if (!ctx) continue
          ctx.drawImage(bitmap, 0, 0, w, h)
          const jpeg = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.84))
          if (!jpeg || jpeg.size > 300 * 1024) continue
          await fetch(`/api/v1/versions/${v.id}/thumb`, {
            method: 'PUT', credentials: 'same-origin', body: jpeg,
          })
          const i = versions.value.findIndex((x) => x.id === v.id)
          if (i >= 0) versions.value[i] = { ...versions.value[i]!, has_thumb: true }
        } finally {
          bitmap.close?.()
        }
      } catch {
        // 缩略图失败只降级:thumb 接口会回退原图
      }
    }
  }

  function selectVersion(id: string) {
    selectedVersionId.value = id
  }

  async function patchProject(id: string, payload: { title?: string; status?: string }) {
    const p = await api.patch<Project>(`/api/v1/projects/${id}`, payload)
    const i = projects.value.findIndex((x) => x.id === id)
    if (i >= 0) projects.value[i] = p
    else projects.value.unshift(p)
    if (p.status !== 'active' || (payload.status && payload.status !== 'active')) await loadProjects()
    return p
  }

  async function deleteProject(id: string) {
    await api.del(`/api/v1/projects/${id}`)
    if (currentId.value === id) {
      currentId.value = null
      messages.value = []
      versions.value = []
      selectedVersionId.value = null
      draft.value = true
    }
    await loadProjects()
  }

  async function uploadReference(file: File): Promise<{ id: string; url: string; filename: string }> {
    const pid = await ensureProject()
    // 浏览器端重编码为 PNG:EXIF/GPS 不离开浏览器;像素超限给出可读错误
    const parsed = await parseFileForUpload(file, 'reference')
    const form = new FormData()
    form.append('project_id', pid)
    const outName = /\.png$/i.test(file.name) ? file.name : file.name.replace(/\.[^.]+$/, '') + '.png'
    form.append('file', parsed.blob, outName)
    return api.upload(`/api/v1/uploads`, form)
  }

  async function starVersion(id: string) {
    const v = await api.patch<Version>(`/api/v1/versions/${id}/star`, {})
    const i = versions.value.findIndex((x) => x.id === id)
    if (i >= 0) versions.value[i] = v
  }

  interface SendPayload {
    prompt: string
    model: string
    sizePreset: string
    sourceVersionId: string | null
    referenceIds: string[]
    discardSource: boolean
  }

  async function send(payload: SendPayload) {
    error.value = ''
    busy.value = true
    try {
      const spec = models.value.find((m) => m.id === payload.model)
      if (payload.sourceVersionId && spec && !spec.supports_edit) {
        throw new Error(`${spec.label} 不支持基于原图修改。请换用支持编辑的模型，或明确选择「放弃原图，重新生成一张」。`)
      }
      const pid = await ensureProject(payload.prompt)
      if (autoTitled.value) {
        // 参考图先建了项目，这里用真实提示词改写占位标题（失败不影响生成）
        autoTitled.value = false
        try { await patchProject(pid, { title: payload.prompt.trim().slice(0, 40) }) } catch { /* 忽略 */ }
      }
      const hash = JSON.stringify([pid, payload.prompt.trim(), payload.model,
        payload.sizePreset, payload.sourceVersionId, payload.referenceIds,
        payload.discardSource])
      const now = Date.now()
      const clientRequestId = (lastSend && lastSend.hash === hash && now - lastSend.at < 15_000)
        ? lastSend.key : newRequestId()
      lastSend = { key: clientRequestId, hash, at: now }
      const body = {
        project_id: pid,
        client_request_id: clientRequestId,
        prompt: payload.prompt,
        model: payload.model,
        size: payload.sizePreset || defaultSize.value,
        quality: '2k',
        source_version_id: payload.discardSource ? null : payload.sourceVersionId,
        reference_ids: payload.referenceIds,
        discard_source: payload.discardSource,
      }
      const res = await api.post<{ job_id: string; message_id: string }>('/api/v1/generate', body)
      await loadMessages()
      await pollJob(res.job_id)
    } catch (e: any) {
      error.value = e?.detail?.message || e?.message || '生成请求失败'
      throw e
    } finally {
      busy.value = false
    }
  }

  function pollJob(jobId: string): Promise<void> {
    const pid = currentId.value
    if (polling.has(jobId)) return Promise.resolve()
    polling.add(jobId)
    return new Promise((resolve) => {
      let ticks = 0
      let delay = POLL_START_MS
      const done = () => { polling.delete(jobId); resolve() }
      const tick = async () => {
        ticks += 1
        if (currentId.value !== pid) { done(); return }   // 切走了就停，别污染新项目
        try {
          const j = await api.get<Job>(`/api/v1/jobs/${jobId}`)
          if (currentId.value !== pid) { done(); return }
          jobs.value = { ...jobs.value, [jobId]: j }
          if (j.status === 'succeeded') {
            await Promise.all([loadMessages(), loadVersions(), loadUsage()])
            if (currentId.value === pid && j.version_id) selectedVersionId.value = j.version_id
            done()
            return
          }
          if (TERMINAL.includes(j.status)) {
            const fallback: Record<string, string> = {
              uncertain: '本次结果待确认（可能已生成并计费），请稍后查看版本列表；系统不会自动重复调用',
              interrupted: '生成被中断，请核对版本列表后再决定是否重新提交',
              failed: '生成失败，请重试',
            }
            error.value = j.error || fallback[j.status] ||
              (j.status === 'pending_save' ? '图片已生成但保存未完成，请联系管理员恢复' : '生成未成功')
            await loadMessages()
            done()
            return
          }
        } catch (e: any) {
          error.value = e?.message || '查询生成状态失败'
          done()
          return
        }
        if (ticks > POLL_MAX_TICKS) {
          error.value = '生成超时，请稍后刷新项目查看结果'
          done()
          return
        }
        // 页面隐藏:暂停轮询(不消耗请求),回到前台立即补查
        if (document.hidden) {
          const onResume = () => {
            document.removeEventListener('visibilitychange', onResume)
            if (currentId.value === pid && polling.has(jobId)) window.setTimeout(tick, 300)
          }
          document.addEventListener('visibilitychange', onResume)
          return
        }
        delay = Math.min(POLL_MAX_MS, Math.round(delay * POLL_BACKOFF))
        window.setTimeout(tick, delay)
      }
      window.setTimeout(tick, delay)
    })
  }

  async function resumeJobs() {
    if (!currentId.value) return
    try {
      const pid = currentId.value
      const d = await api.get<{ items: Job[] }>(`/api/v1/projects/${pid}/jobs`)
      for (const j of d.items.filter((x) => ACTIVE.includes(x.status))) void pollJob(j.id)
    } catch { /* 忽略 */ }
  }

  return {
    projects, currentId, messages, versions, models, defaultModel,
    sizePresets, defaultSize, usage,
    selectedVersionId, jobs, busy, loading, error, search, draft,
    currentProject, selectedVersion, latestVersion, hasActiveJob, currentModel,
    downloadUrl, loadModels, loadUsage, loadProjects, createProject, newDraft,
    ensureProject, openProject,
    loadMessages, loadVersions, selectVersion, patchProject, deleteProject,
    uploadReference, starVersion,
    send, pollJob, resumeJobs,
  }
})
