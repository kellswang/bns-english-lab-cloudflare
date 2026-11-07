<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ChatMessageItem } from '../../types'
import { renderMarkdown } from '../../utils/markdown'

const props = defineProps<{
  msg: ChatMessageItem
  modelLabel: string
  branchIndex: number
  branchTotal: number
  streaming?: boolean
}>()
const emit = defineEmits<{
  (e: 'regenerate', id: string): void
  (e: 'edit', id: string, text: string): void
  (e: 'branch', id: string): void
  (e: 'copy'): void
}>()

const editing = ref(false)
const draft = ref('')
const copied = ref(false)
const html = computed(() => renderMarkdown(props.msg.content))

// 只在「还没有任何内容」时显示生成中，避免长回答上方一直挂着状态行
const showStatus = computed(() => props.msg.status === 'streaming' && !props.msg.content)

const metaText = computed(() => {
  const bits: string[] = []
  if (props.msg.model && props.modelLabel) bits.push(props.modelLabel)
  if (props.msg.duration_ms) bits.push((props.msg.duration_ms / 1000).toFixed(1) + 's')
  const t = props.msg.usage?.completion_tokens
  if (t) bits.push(t + ' tokens')
  return bits.join(' · ')
})

watch(() => props.msg.content, () => { if (props.msg.status === 'streaming') editing.value = false })

function startEdit() {
  draft.value = props.msg.content
  editing.value = true
}

async function copy() {
  try {
    await navigator.clipboard.writeText(props.msg.content)
    copied.value = true
    window.setTimeout(() => { copied.value = false }, 1400)
    emit('copy')
  } catch { /* 剪贴板不可用 */ }
}

function submitEdit() {
  const text = draft.value.trim()
  if (!text) return
  editing.value = false
  emit('edit', props.msg.id, text)
}
</script>

<template>
  <article class="msg" :class="msg.role">
    <div v-if="msg.attachments?.length" class="msg-atts">
      <a v-for="a in msg.attachments" :key="a.id" class="msg-att"
         :href="`/api/v1/chat/attachments/${a.id}/file`" target="_blank" rel="noopener">
        <img v-if="a.kind === 'image'" :src="`/api/v1/chat/attachments/${a.id}/file`" :alt="a.filename" />
        <span v-else class="msg-att-doc">{{ a.kind === 'pdf' ? 'PDF' : (a.kind === 'docx' ? 'DOCX' : 'TXT') }}</span>
        <span class="msg-att-name">{{ a.filename }}</span>
      </a>
    </div>

    <div v-if="editing" class="msg-edit">
      <textarea v-model="draft" class="textarea" rows="3" />
      <div class="msg-edit-actions">
        <button class="btn btn-sm" @click="editing = false">取消</button>
        <button class="btn btn-sm btn-primary" @click="submitEdit">保存并重新生成</button>
      </div>
    </div>

    <template v-else>
      <div v-if="showStatus" class="msg-statusline">
        <span class="spinner" />正在生成…
      </div>

      <div v-if="msg.role === 'user'" class="msg-body user-text">{{ msg.content }}</div>
      <div v-else class="msg-body markdown" v-html="html" />

      <p v-if="msg.status === 'stopped'" class="msg-note">已停止生成</p>
      <p v-if="msg.status === 'failed' && msg.error" class="msg-error">{{ msg.error }}</p>
      <p v-else-if="msg.status === 'interrupted'" class="msg-error">
        服务重启或网络中断，这条回答可能不完整。可点「重新生成」再问一次（会重新计费）。
      </p>

      <div class="msg-actions">
        <span v-if="metaText" class="msg-meta-text">{{ metaText }}</span>
        <span v-if="branchTotal > 1" class="msg-branch">
          分支 {{ branchIndex }}/{{ branchTotal }}
          <button class="link-btn" title="切换分支" @click="emit('branch', msg.id)">切换</button>
        </span>

        <template v-if="msg.role === 'assistant' && !streaming">
          <button class="icon-btn" :class="{ on: copied }" :title="copied ? '已复制' : '复制'"
                  aria-label="复制" @click="copy">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="5.4" y="5.4" width="7.4" height="7.4" rx="1.6" stroke="currentColor"
                    stroke-width="1.25" />
              <path d="M10.4 3.6a1.6 1.6 0 00-1.6-1.6H4.2a1.6 1.6 0 00-1.6 1.6v4.6a1.6 1.6 0 001.6 1.6"
                    stroke="currentColor" stroke-width="1.25" stroke-linecap="round" />
            </svg>
          </button>
          <button class="icon-btn" title="重新生成" aria-label="重新生成"
                  @click="emit('regenerate', msg.id)">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M13.2 8a5.2 5.2 0 11-1.7-3.85" stroke="currentColor" stroke-width="1.3"
                    stroke-linecap="round" />
              <path d="M13.4 2.4v3.2h-3.2" stroke="currentColor" stroke-width="1.3"
                    stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </template>

        <button v-if="msg.role === 'user' && !streaming" class="icon-btn"
                title="编辑并重新提问" aria-label="编辑并重新提问" @click="startEdit">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10.9 2.9l2.2 2.2L6 12.2l-2.9.7.7-2.9 7.1-7.1z" stroke="currentColor"
                  stroke-width="1.25" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </template>
  </article>
</template>
