import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, ApiError } from '../api/client'
import { parseFileForUpload, ParseError } from '../utils/attachParse'
import type {
  ChatAttachmentMeta, ChatConversationDetail, ChatConversationSummary,
  ChatMessageItem, ChatModel, ChatModelsResponse, ChatThinkingLevel,
} from '../types'

function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined
  return c?.randomUUID ? c.randomUUID() : `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export const useChat = defineStore('chat', () => {
  const models = ref<ChatModel[]>([])
  const thinkingLevels = ref<ChatThinkingLevel[]>([])
  const defaultModel = ref('')
  const defaultThinking = ref('standard')

  const conversations = ref<ChatConversationSummary[]>([])
  const currentId = ref<string | null>(null)
  const current = ref<ChatConversationDetail | null>(null)
  const messages = ref<ChatMessageItem[]>([])
  const activePath = ref<string[]>([])

  const draft = ref('')
  const attachments = ref<ChatAttachmentMeta[]>([])
  const modelId = ref('')
  const thinking = ref('standard')
  const search = ref('')
  const loading = ref(false)
  const streaming = ref(false)
  const error = ref('')
  let controller: AbortController | null = null

  const currentModel = computed(() => models.value.find((m) => m.id === modelId.value) || null)
  const availableThinking = computed(() => {
    const m = currentModel.value
    if (!m) return [] as ChatThinkingLevel[]
    return thinkingLevels.value.filter((lv) => m.available_thinking.includes(lv.id))
  })
  const visibleMessages = computed(() => {
    const path = new Set(activePath.value)
    return messages.value.filter((m) => path.has(m.id))
  })
  const hasActiveStream = computed(() => messages.value.some((m) => m.status === 'streaming'))

  function applyModelThinking(m: ChatModel | null) {
    if (!m) return
    if (!m.available_thinking.includes(thinking.value)) {
      thinking.value = m.available_thinking.includes(defaultThinking.value)
        ? defaultThinking.value
        : (m.available_thinking[0] || 'standard')
    }
  }

  async function loadModels() {
    const d = await api.get<ChatModelsResponse>('/api/v1/chat/models')
    models.value = d.items
    thinkingLevels.value = d.thinking_levels
    defaultModel.value = d.default
    defaultThinking.value = d.default_thinking || 'standard'
    if (!modelId.value) {
      const saved = localStorage.getItem('bns_chat_model')
      const ok = d.items.find((m) => m.id === saved && m.status === 'ok')
      modelId.value = ok ? ok.id : d.default
    }
    applyModelThinking(currentModel.value)
  }

  function selectModel(id: string) {
    modelId.value = id
    localStorage.setItem('bns_chat_model', id)
    applyModelThinking(currentModel.value)
    void persistModelChoice()
  }

  function selectThinking(level: string) {
    thinking.value = level
    void persistModelChoice()
  }

  async function persistModelChoice() {
    if (!current.value) return
    try {
      await api.patch(`/api/v1/chat/conversations/${current.value.id}`,
        { model: modelId.value, thinking: thinking.value })
    } catch { /* 落库失败不影响对话 */ }
  }

  async function loadConversations() {
    const q = search.value.trim()
    const d = await api.get<{ items: ChatConversationSummary[] }>(
      '/api/v1/chat/conversations' + (q ? `?q=${encodeURIComponent(q)}` : ''))
    conversations.value = d.items
  }

  async function createConversation(): Promise<string> {
    const d = await api.post<{ id: string }>('/api/v1/chat/conversations', {
      model: modelId.value || defaultModel.value,
      thinking: thinking.value,
    })
    currentId.value = d.id
    await loadConversations()
    await openConversation(d.id)
    return d.id
  }

  /** 每次切会话自增；响应回来时序号变了就丢弃（A/B 快速切换不会被旧响应覆盖） */
  let openSeq = 0
  /** 每个会话各自的草稿与附件，切换时不串台 */
  const draftStore = new Map<string, string>()
  const attStore = new Map<string, ChatAttachmentMeta[]>()
  const keyOf = (id: string | null) => id ?? '__new__'

  function stashComposer() {
    draftStore.set(keyOf(currentId.value), draft.value)
    attStore.set(keyOf(currentId.value), [...attachments.value])
  }

  function restoreComposer(id: string | null) {
    draft.value = draftStore.get(keyOf(id)) ?? ''
    attachments.value = attStore.get(keyOf(id)) ?? []
  }

  async function openConversation(id: string, opts: { keepComposer?: boolean } = {}) {
    if (!opts.keepComposer) stashComposer()
    const seq = ++openSeq
    const d = await api.get<ChatConversationDetail>(`/api/v1/chat/conversations/${id}`)
    if (seq !== openSeq) return                    // 已经有更新的打开请求
    currentId.value = d.id
    current.value = d
    messages.value = d.messages
    activePath.value = d.active_path
    modelId.value = d.model || modelId.value
    thinking.value = d.thinking || thinking.value
    applyModelThinking(currentModel.value)
    if (!opts.keepComposer) restoreComposer(d.id)
  }

  /** 回到「新对话」首页：只在本地清空，不创建空会话（发出第一条消息时才落库） */
  function startNewChat() {
    stashComposer()
    openSeq += 1                 // 让在途的 openConversation 失效
    currentId.value = null
    current.value = null
    messages.value = []
    activePath.value = []
    error.value = ''
    restoreComposer(null)
  }

  async function renameConversation(id: string, title: string) {
    await api.patch(`/api/v1/chat/conversations/${id}`, { title })
    await loadConversations()
    if (current.value && current.value.id === id) current.value.title = title
  }

  async function deleteConversation(id: string) {
    await api.del(`/api/v1/chat/conversations/${id}`)
    conversations.value = conversations.value.filter((c) => c.id !== id)
    if (currentId.value === id) startNewChat()
  }

  async function uploadAttachment(file: File): Promise<ChatAttachmentMeta | null> {
    let id = currentId.value
    if (!id) id = await createConversation()
    // 浏览器端解析:PDF/DOCX/TXT 抽正文、图片去 EXIF 并缩到模型输入尺寸
    const parsed = await parseFileForUpload(file, 'chat')
    const form = new FormData()
    const outName = parsed.contentType === 'image/png' && /\.jpe?g$|\.webp$/i.test(file.name)
      ? file.name.replace(/\.[^.]+$/, '') + '.png'
      : file.name
    form.append('file', parsed.blob, outName)
    if (parsed.extractedText !== null) form.append('extracted_text', parsed.extractedText)
    if (parsed.pageCount !== null) form.append('page_count', String(parsed.pageCount))
    form.append('text_truncated', parsed.textTruncated ? '1' : '0')
    const meta = await api.upload<ChatAttachmentMeta>(
      `/api/v1/chat/conversations/${id}/attachments`, form)
    attachments.value.push(meta)
    return meta
  }

  function removeAttachment(id: string) {
    attachments.value = attachments.value.filter((a) => a.id !== id)
  }

  async function send(opts: { text?: string; editOf?: string | null; regenerateOf?: string | null } = {}) {
    if (streaming.value) return
    const text = (opts.text ?? draft.value).trim()
    const isRegen = !!opts.regenerateOf
    const isEdit = !!opts.editOf
    if (!isRegen && !isEdit && !text && !attachments.value.length) return

    error.value = ''
    let convId = currentId.value
    if (!convId) convId = await createConversation()

    const atts = isRegen ? [] : attachments.value.map((a) => a.id)
    const clientRequestId = newRequestId()
    // 失败时要把用户刚写的内容还回去（只还回这次发送的那份，不覆盖之后的新输入）
    const sentDraft = text
    const sentAtts = [...attachments.value]
    const now = new Date().toISOString()
    let optimisticUser: ChatMessageItem | null = null

    if (!isRegen && !isEdit) {
      optimisticUser = {
        id: 'tmp-user-' + Date.now(), parent_id: null, role: 'user', content: text,
        status: 'complete', model: null, thinking: null,
        attachments: [...attachments.value], usage: {}, request_id: null,
        duration_ms: null, error: null, created_at: now,
      }
      messages.value.push(optimisticUser)
    }

    const tempAssistant: ChatMessageItem = {
      id: 'tmp-assistant-' + Date.now(), parent_id: null, role: 'assistant', content: '',
      status: 'streaming', model: modelId.value, thinking: thinking.value,
      attachments: [], usage: {}, request_id: null, duration_ms: null, error: null,
      created_at: now,
    }
    messages.value.push(tempAssistant)
    if (optimisticUser) activePath.value = [...activePath.value, optimisticUser.id, tempAssistant.id]

    draft.value = ''
    attachments.value = []
    controller = new AbortController()
    streaming.value = true

    try {
      const res = await fetch(`/api/v1/chat/conversations/${convId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
        body: JSON.stringify({
          content: text,
          model: modelId.value,
          thinking: thinking.value,
          attachment_ids: atts,
          edit_of: opts.editOf || null,
          regenerate_of: opts.regenerateOf || null,
          client_request_id: clientRequestId,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const body = await res.text()
        let msg = `请求失败 (${res.status})`
        try {
          const d = JSON.parse(body)
          if (typeof d.detail === 'string') msg = d.detail
        } catch { /* 保留默认 */ }
        throw new ApiError(res.status, msg)
      }
      await consume(res, tempAssistant.id, optimisticUser)
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        const t = messages.value.find((m) => m.id === tempAssistant.id)
        if (t && t.status === 'streaming') t.status = 'stopped'
      } else {
        error.value = e?.message || '发送失败'
        const t = messages.value.find((m) => m.id === tempAssistant.id)
        if (t && !t.content) { t.status = 'failed'; t.error = error.value }
        // 把草稿与附件还回去，避免网络抖动让教师白写一段
        if (!draft.value) draft.value = sentDraft
        if (!attachments.value.length) attachments.value = sentAtts
      }
    } finally {
      streaming.value = false
      controller = null
      try {
        // 用户中途切到别的会话时，不要把他拉回来；后台结果已在服务端落库
        if (convId && (currentId.value === null || currentId.value === convId)) {
          await openConversation(convId, { keepComposer: true })
        }
        await loadConversations()
      } catch { /* 刷新失败保留本地状态 */ }
    }
  }

  /** 消费服务端 SSE：首个 token 到达即渲染；start 事件把临时 id 对齐真实 id。 */
  async function consume(res: Response, tempId: string, tempUser: ChatMessageItem | null) {
    const reader = res.body?.getReader()
    if (!reader) throw new Error('浏览器不支持流式读取')
    const decoder = new TextDecoder()
    let buffer = ''
    let acc = ''
    let liveId = tempId

    const handle = (raw: string) => {
      const line = raw.trim()
      if (!line.startsWith('data:')) return
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') return
      let ev: any
      try { ev = JSON.parse(payload) } catch { return }

      if (ev.type === 'start') {
        // 先把旧 id 存下来：对象是同一个引用，改完 id 就再也匹配不到 activePath 里的旧值，
        // 结果用户消息会从可见路径里消失，直到最后强制刷新
        const oldAssistantId = liveId
        const oldUserId = tempUser ? tempUser.id : null
        const target = messages.value.find((m) => m.id === oldAssistantId)
        if (target) target.id = ev.assistant_message_id
        liveId = ev.assistant_message_id
        if (tempUser) {
          const ut = messages.value.find((m) => m.id === oldUserId)
          if (ut) ut.id = ev.user_message_id
        }
        activePath.value = activePath.value.map((x) => (
          x === oldUserId ? ev.user_message_id
            : (x === oldAssistantId ? ev.assistant_message_id : x)))
        if (ev.title) {
          if (current.value) current.value.title = ev.title
          const row = conversations.value.find((c) => c.id === ev.conversation_id)
          if (row) row.title = ev.title
        }
      } else if (ev.type === 'delta') {
        acc += ev.text as string
        const target = messages.value.find((m) => m.id === liveId)
        if (target) { target.content = acc; target.status = 'streaming' }
      } else if (ev.type === 'meta') {
        const target = messages.value.find((m) => m.id === liveId)
        if (target && ev.request_id) target.request_id = ev.request_id
      } else if (ev.type === 'error') {
        error.value = ev.message || '生成失败'
        if (!acc) {
          const target = messages.value.find((m) => m.id === liveId)
          if (target) { target.status = 'failed'; target.error = error.value }
        }
      } else if (ev.type === 'finish') {
        const target = messages.value.find((m) => m.id === liveId)
        if (target) {
          target.status = ev.status
          target.usage = ev.usage || {}
          target.duration_ms = ev.duration_ms ?? null
          target.error = ev.error || null
          if (!target.content) target.content = acc
        }
        if (ev.status !== 'complete' && ev.error) error.value = ev.error
      }
    }

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() || ''
        for (const p of parts) handle(p)
      }
      if (buffer.trim()) handle(buffer)
    } finally {
      streaming.value = false
    }
  }

  async function stop() {
    const live = messages.value.find((m) => m.status === 'streaming' && !m.id.startsWith('tmp-'))
    if (live) {
      try { await api.post(`/api/v1/chat/messages/${live.id}/stop`) } catch { /* 已结束 */ }
    }
    controller?.abort()
    controller = null
    streaming.value = false
  }

  async function regenerate(assistantId: string) {
    await send({ regenerateOf: assistantId })
  }

  async function editAndResend(userMessageId: string, newText: string) {
    await send({ text: newText, editOf: userMessageId })
  }

  async function activateBranch(messageId: string) {
    await api.post(`/api/v1/chat/messages/${messageId}/activate`)
    if (currentId.value) await openConversation(currentId.value)
  }

  return {
    models, thinkingLevels, defaultModel, defaultThinking,
    conversations, currentId, current, messages, activePath,
    draft, attachments, modelId, thinking, search,
    loading, streaming, error,
    currentModel, availableThinking, visibleMessages, hasActiveStream,
    loadModels, loadConversations, createConversation, openConversation, startNewChat,
    renameConversation, deleteConversation, persistModelChoice,
    selectModel, selectThinking,
    uploadAttachment, removeAttachment, send, stop, regenerate,
    editAndResend, activateBranch, applyModelThinking,
  }
})
