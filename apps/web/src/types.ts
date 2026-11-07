export interface User {
  id: string
  email: string
  display_name: string
  role: 'teacher' | 'admin'
  status: 'pending' | 'active' | 'suspended'
}

export interface ModelSpec {
  id: string
  label: string
  tag: string
  description: string
  supports_edit: boolean
  supports_reference: boolean
  enabled: boolean
  health: string
  sizes: string[]
  qualities: string[]
}

export interface Project {
  id: string
  title: string
  status: 'active' | 'archived' | 'deleted'
  owner_id: string
  permission: 'owner' | 'edit' | 'view'
  created_at: string | null
  updated_at: string | null
  has_images: boolean
}

export interface MessageItem {
  id: string
  role: string
  kind: string
  content: string
  attachments: string[]
  meta: Record<string, any>
  created_at: string | null
}

export interface Version {
  id: string
  project_id: string
  message_id: string | null
  parent_id: string | null
  source_version_id: string | null
  version_no: number
  branch_name: string
  mode: 'generate' | 'edit'
  model: string
  prompt: string
  revised_prompt: string | null
  params: Record<string, any>
  width: number | null
  height: number | null
  size_bytes: number
  is_starred: boolean
  created_at: string | null
  url: string
  thumb_url: string
}

export interface Job {
  id: string
  status: 'queued' | 'submitted' | 'running' | 'succeeded' | 'failed' | 'uncertain' | 'interrupted' | 'pending_save'
  error: string | null
  version_id: string | null
  version_no?: number
  model: string
  mode: string
  created_at: string
  deduplicated?: boolean
}

export interface SizePreset {
  id: string
  label: string
  pixels: string
  ratio: number
  group: string
  orientation: 'portrait' | 'landscape' | 'square'
}

export interface Usage {
  images: number
  amount_usd: number
  chat_amount_usd: number
  chat_pending: number
  total_usd: number
  unit_price_usd: number
  currency: string
  scope: string
}

/* ---------------- AI 对话 ---------------- */
export interface ChatThinkingLevel {
  id: string
  label: string
}

export interface ChatModel {
  id: string
  label: string
  vendor: string
  description: string
  status: 'ok' | 'unavailable' | 'degraded'
  status_reason: string
  supports_vision: boolean
  supports_documents: boolean
  context_window: number
  max_output_tokens: number
  available_thinking: string[]
  default_thinking: string
}

export interface ChatModelsResponse {
  items: ChatModel[]
  default: string
  thinking_levels: ChatThinkingLevel[]
  default_thinking: string
}

export interface ChatAttachmentMeta {
  id: string
  kind: 'image' | 'pdf' | 'docx' | 'text'
  filename: string
  content_type: string
  size_bytes: number
}

export interface ChatMessageItem {
  id: string
  parent_id: string | null
  role: 'user' | 'assistant' | 'system'
  content: string
  status: 'complete' | 'streaming' | 'stopped' | 'failed' | 'interrupted'
  model: string | null
  thinking: string | null
  attachments: ChatAttachmentMeta[]
  usage: Record<string, number>
  request_id: string | null
  duration_ms: number | null
  error: string | null
  created_at: string | null
}

export interface ChatConversationSummary {
  id: string
  title: string
  model: string
  thinking: string
  message_count: number
  preview: string
  updated_at: string
}

export interface ChatConversationDetail {
  id: string
  title: string
  model: string
  thinking: string
  summary: string | null
  active_leaf_id: string | null
  active_path: string[]
  messages: ChatMessageItem[]
}

/* ---------------- 管理页（仅 admin 可见） ---------------- */
export interface AdminUserUsage {
  id: string
  email: string
  display_name: string
  role: string
  status: string
  created_at: string | null
  last_login_at: string | null
  images: number
  image_amount_usd: number
  chat_amount_usd: number
  chat_pending: number
  total_usd: number
}

export interface AdminOverview {
  users: AdminUserUsage[]
  totals: {
    users: number
    images: number
    image_amount_usd: number
    chat_amount_usd: number
    chat_pending: number
    total_usd: number
  }
  unit_price_usd: number
  currency: string
  basis: string
  note: string
}

export interface AdminLogItem {
  id: string
  actor_email: string | null
  actor_name: string | null
  action: string
  entity_id: string | null
  detail: string | null
  ip: string | null
  created_at: string | null
}

export interface AdminLogsResponse {
  items: AdminLogItem[]
  total: number
  limit: number
  offset: number
  actions: string[]
}
