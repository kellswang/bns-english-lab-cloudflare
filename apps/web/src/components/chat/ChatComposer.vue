<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useChat } from '../../stores/chat'
import { useFloatingMenu } from '../../composables/useFloatingMenu'

const chat = useChat()
const text = ref('')
const modelOpen = ref(false)
const thinkOpen = ref(false)
const fileEl = ref<HTMLInputElement | null>(null)
const boxEl = ref<HTMLTextAreaElement | null>(null)
const uploading = ref(false)
const uploadError = ref('')

// 两个下拉都渲染到 body 上，避免被输入框所在容器的 overflow 裁掉
const modelAnchorEl = ref<HTMLElement | null>(null)
const modelMenuEl = ref<HTMLElement | null>(null)
const thinkAnchorEl = ref<HTMLElement | null>(null)
const thinkMenuEl = ref<HTMLElement | null>(null)
const modelMenu = useFloatingMenu(modelAnchorEl, modelMenuEl, modelOpen, {
  minWidth: 330, maxHeight: 420, onDismiss: () => { modelOpen.value = false },
})
const thinkMenu = useFloatingMenu(thinkAnchorEl, thinkMenuEl, thinkOpen, {
  minWidth: 214, maxHeight: 340, onDismiss: () => { thinkOpen.value = false },
})
const modelMenuStyle = modelMenu.style
const thinkMenuStyle = thinkMenu.style

const canSend = computed(() => !chat.streaming
  && (text.value.trim().length > 0 || chat.attachments.length > 0)
  && chat.currentModel?.status === 'ok')

const groupedModels = computed(() => {
  const out: { vendor: string; items: typeof chat.models }[] = []
  for (const m of chat.models) {
    let g = out.find((x) => x.vendor === m.vendor)
    if (!g) { g = { vendor: m.vendor, items: [] }; out.push(g) }
    g.items.push(m)
  }
  return out
})

const thinkingLabel = computed(() => chat.thinkingLevels.find((x) => x.id === chat.thinking)?.label || '标准')
const modelLabel = computed(() => chat.currentModel?.label || '选择模型')

watch(() => chat.draft, (v) => { if (v && v !== text.value) text.value = v })
watch(text, (v) => { chat.draft = v })

function autosize() {
  const el = boxEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(240, el.scrollHeight) + 'px'
}

// 窗口变窄后同一段文字会占更多行，重新量一次高度
onMounted(() => window.addEventListener('resize', autosize))
onUnmounted(() => window.removeEventListener('resize', autosize))

function focus() {
  boxEl.value?.focus()
}

defineExpose({ focus })

function pickModel(id: string, status: string) {
  if (status !== 'ok') return
  modelOpen.value = false
  chat.selectModel(id)
}

function pickThinking(id: string) {
  thinkOpen.value = false
  chat.selectThinking(id)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  if ((e as any).isComposing) return
  e.preventDefault()
  void submit()
}

async function submit() {
  if (!canSend.value) return
  const t = text.value
  text.value = ''
  chat.draft = ''
  await nextTick(autosize)
  await chat.send({ text: t })
}

async function onFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  uploadError.value = ''
  if (!files.length) return
  uploading.value = true
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { uploadError.value = `${f.name} 超过 20MB`; continue }
    try {
      await chat.uploadAttachment(f)
    } catch (err: any) {
      uploadError.value = err?.message || '上传失败'
    }
  }
  uploading.value = false
}
</script>

<template>
  <div class="chat-composer">
    <div v-if="chat.attachments.length" class="att-strip">
      <div v-for="a in chat.attachments" :key="a.id" class="att-chip">
        <span class="att-kind">{{ a.kind === 'image' ? '图' : a.kind.toUpperCase() }}</span>
        <span class="att-name">{{ a.filename }}</span>
        <button class="att-x" title="移除" @click="chat.removeAttachment(a.id)">×</button>
      </div>
    </div>

    <textarea ref="boxEl" v-model="text" class="chat-input" rows="1"
              :placeholder="chat.currentModel?.status === 'ok'
                ? '有什么需要我帮忙的？'
                : '当前模型不可用，请先选择一个可用模型'"
              @input="autosize" @keydown="onKeydown" />

    <div class="composer-row">
      <input ref="fileEl" type="file" style="display:none"
             accept="image/png,image/jpeg,image/webp,application/pdf,.docx,.txt,.md,.csv"
             @change="onFiles" />
      <button class="composer-tool" type="button" title="上传课文、图片或 PDF"
              :disabled="uploading || chat.streaming" @click="fileEl?.click()">
        <span v-if="uploading" class="spinner" />
        <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M10.6 5.2L6.1 9.7a2.1 2.1 0 003 3l4.6-4.6a3.4 3.4 0 00-4.8-4.8L4 8.2a4.7 4.7 0 006.6 6.6l3.3-3.3"
                stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <span>{{ uploading ? '解析中…' : '附件' }}</span>
      </button>

      <div ref="modelAnchorEl" class="picker">
        <button class="picker-trigger" :class="{ open: modelOpen }" type="button"
                title="选择模型" @click="modelOpen = !modelOpen; thinkOpen = false">
          <span class="picker-value">{{ modelLabel }}</span><span class="caret" />
        </button>
        <Teleport to="body">
          <div v-if="modelOpen" ref="modelMenuEl" class="picker-menu model-menu chat-model-menu"
               :style="modelMenuStyle">
            <div v-for="g in groupedModels" :key="g.vendor" class="picker-group">
              <div class="picker-group-label">{{ g.vendor }}</div>
              <button v-for="m in g.items" :key="m.id" class="picker-option"
                      :class="{ active: chat.modelId === m.id, disabled: m.status !== 'ok' }"
                      type="button" @click="pickModel(m.id, m.status)">
                <div class="picker-line">
                  <b>{{ m.label }}</b>
                  <span v-if="m.status !== 'ok'" class="tag tag-warn">不可用</span>
                  <span v-if="chat.modelId === m.id" class="picker-check">✓</span>
                </div>
                <p class="picker-desc">{{ m.description }}</p>
                <p v-if="m.status !== 'ok'" class="picker-desc" style="color:var(--danger)">
                  {{ m.status_reason }}
                </p>
              </button>
            </div>
          </div>
        </Teleport>
      </div>

      <div ref="thinkAnchorEl" class="picker">
        <button class="picker-trigger think-trigger" :class="{ open: thinkOpen }" type="button"
                title="思考深度" @click="thinkOpen = !thinkOpen; modelOpen = false">
          <span class="picker-value">{{ thinkingLabel }}</span><span class="caret" />
        </button>
        <Teleport to="body">
          <div v-if="thinkOpen" ref="thinkMenuEl" class="picker-menu think-menu"
               :style="thinkMenuStyle">
            <button v-for="lv in chat.thinkingLevels" :key="lv.id" class="picker-option compact"
                    :class="{ active: chat.thinking === lv.id, disabled: !chat.availableThinking.some(x => x.id === lv.id) }"
                    type="button"
                    @click="chat.availableThinking.some(x => x.id === lv.id) ? pickThinking(lv.id) : null">
              <div class="picker-line">
                <b>{{ lv.label }}</b>
                <span v-if="!chat.availableThinking.some(x => x.id === lv.id)" class="picker-pixels">该模型不支持</span>
                <span v-else-if="chat.thinking === lv.id" class="picker-check">✓</span>
              </div>
            </button>
            <p class="think-note">思考深度会按模型实际能力映射为厂商参数；不支持的档位不会假装开启。</p>
          </div>
        </Teleport>
      </div>

      <button v-if="chat.streaming" class="composer-stop" type="button"
              title="停止生成" aria-label="停止生成" @click="chat.stop()">
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.6" />
        </svg>
      </button>
      <button v-else class="composer-send" type="button"
              :disabled="!canSend" :title="canSend ? '发送（Enter）' : '输入内容后发送'"
              aria-label="发送" @click="submit">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 12.6V3.6M4.2 7.4L8 3.6l3.8 3.8" stroke="currentColor"
                stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
    <p v-if="uploadError" class="composer-error">{{ uploadError }}</p>
  </div>
</template>
