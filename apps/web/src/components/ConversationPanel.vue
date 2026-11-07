<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useWorkspace } from '../stores/workspace'
import { useFloatingMenu } from '../composables/useFloatingMenu'
import type { SizePreset } from '../types'

const props = defineProps<{ blank?: boolean; collapsed?: boolean; hasCanvas?: boolean }>()
const emit = defineEmits<{
  (e: 'notice', text: string): void
  (e: 'expand'): void
  (e: 'open-side'): void
  (e: 'open-canvas'): void
}>()
const ws = useWorkspace()

const prompt = ref('')
const modelId = ref('')
const sizePreset = ref('')
const refs = ref<{ id: string; url: string; filename: string }[]>([])
const discardSource = ref(false)
const fileEl = ref<HTMLInputElement | null>(null)
const boxEl = ref<HTMLTextAreaElement | null>(null)
const scroller = ref<HTMLElement | null>(null)
const uploading = ref(false)
const localError = ref('')

watch(() => ws.defaultModel, (v) => { if (v && !modelId.value) modelId.value = v }, { immediate: true })
watch(() => ws.defaultSize, (v) => { if (v && !sizePreset.value) sizePreset.value = v }, { immediate: true })
watch(() => ws.selectedVersionId, () => {
  const v = ws.selectedVersion
  if (v && ws.models.some((m) => m.id === v.model)) modelId.value = v.model
  discardSource.value = false
}, { immediate: true })
// 切到另一个已有项目时清空参考图；从空白创作首次落库（null → id）时保留刚上传的图
watch(() => ws.currentId, (_n, old) => {
  if (old) { refs.value = []; localError.value = '' }
})

// 新内容进来时贴到底部；用户向上翻阅时不打断
const nearBottom = ref(true)
watch(() => ws.messages.length, async () => {
  await nextTick()
  const el = scroller.value
  if (el && nearBottom.value) el.scrollTop = el.scrollHeight
})
function onScroll() {
  const el = scroller.value
  if (!el) return
  nearBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 140
}

const model = computed(() => ws.models.find((m) => m.id === modelId.value) || null)
const source = computed(() => ws.selectedVersion)
const editing = computed(() => !!source.value && !discardSource.value)
const blocked = computed(() => editing.value && !!model.value && !model.value.supports_edit)
const canSend = computed(() => !!prompt.value.trim() && !ws.busy && !ws.hasActiveJob && !blocked.value)
const sizeGroups = computed(() => {
  const groups: { label: string; items: SizePreset[] }[] = []
  for (const p of ws.sizePresets) {
    let g = groups.find((x) => x.label === p.group)
    if (!g) { g = { label: p.group, items: [] }; groups.push(g) }
    g.items.push(p)
  }
  return groups
})
const modelOpen = ref(false)
const sizeOpen = ref(false)
const modelAnchorEl = ref<HTMLElement | null>(null)
const modelMenuEl = ref<HTMLElement | null>(null)
const sizeAnchorEl = ref<HTMLElement | null>(null)
const sizeMenuEl = ref<HTMLElement | null>(null)
const modelMenu = useFloatingMenu(modelAnchorEl, modelMenuEl, modelOpen, {
  minWidth: 300, maxHeight: 420, onDismiss: () => { modelOpen.value = false },
})
const sizeMenu = useFloatingMenu(sizeAnchorEl, sizeMenuEl, sizeOpen, {
  minWidth: 236, maxHeight: 420, align: 'left', onDismiss: () => { sizeOpen.value = false },
})
const modelMenuStyle = modelMenu.style
const sizeMenuStyle = sizeMenu.style
const currentModelLabel = computed(() => ws.models.find((m) => m.id === modelId.value)?.label || '选择模型')
const currentSizeLabel = computed(() => ws.sizePresets.find((s) => s.id === sizePreset.value)?.label || '选择画幅')

function toggleModel() { sizeOpen.value = false; modelOpen.value = !modelOpen.value }
function toggleSize() { modelOpen.value = false; sizeOpen.value = !sizeOpen.value }
function pickModel(id: string) { modelId.value = id; modelOpen.value = false }
function pickSize(id: string) { sizePreset.value = id; sizeOpen.value = false }

function statusText(m: Record<string, any>) {
  const s = m?.status
  if (s === 'succeeded') return '已生成'
  if (s === 'failed') return '生成失败'
  if (s === 'uncertain') return '结果待确认'
  if (s === 'interrupted') return '已中断'
  if (s === 'submitted') return '模型处理中'
  return '正在生成'
}
const isPending = (m: Record<string, any>) =>
  !['succeeded', 'failed', 'uncertain', 'interrupted'].includes(m?.status)
function modeText(m: Record<string, any>) {
  if (m?.mode === 'edit') return `基于 V${m.source_version_no ?? '?'} 修改`
  if (m?.discard_source) return '重新生成'
  return '全新生成'
}

async function onFiles(e: Event) {
  const el = e.target as HTMLInputElement
  const files = Array.from(el.files || []).slice(0, 4 - refs.value.length)
  el.value = ''
  if (!files.length) return
  uploading.value = true
  localError.value = ''
  try {
    for (const f of files) {
      if (f.size > 12 * 1024 * 1024) { localError.value = '单张参考图不能超过 12 MB'; continue }
      try { refs.value.push(await ws.uploadReference(f)) }
      catch (err: any) { localError.value = err?.message || '参考图上传失败' }
    }
  } finally { uploading.value = false }
}
function removeRef(id: string) { refs.value = refs.value.filter((r) => r.id !== id) }

/** 输入框随内容自动增高（与对话模式一致），去掉原生缩放手柄 */
function autosize() {
  const el = boxEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(200, Math.max(52, el.scrollHeight)) + 'px'
}
watch(() => props.blank, async () => { await nextTick(); autosize() })
// 窗口尺寸变化后行数会变，重新量一次输入框高度
onMounted(() => window.addEventListener('resize', autosize))
onUnmounted(() => window.removeEventListener('resize', autosize))

async function submit() {
  if (!canSend.value) return
  localError.value = ''
  const text = prompt.value.trim()
  prompt.value = ''
  await nextTick(autosize)
  try {
    await ws.send({
      prompt: text,
      model: modelId.value,
      sizePreset: sizePreset.value,
      sourceVersionId: editing.value ? (source.value?.id ?? null) : null,
      referenceIds: refs.value.map((r) => r.id),
      discardSource: discardSource.value && !!source.value,
    })
    refs.value = []
    discardSource.value = false
  } catch (e: any) {
    localError.value = e?.detail?.message || e?.message || '生成失败'
    prompt.value = text
    await nextTick(autosize)
  }
}

function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void submit() }
}
</script>

<template>
  <section class="col col-mid img-chat" :class="{ 'is-blank': blank }">
    <header class="col-head img-head">
      <button class="chat-side-toggle" type="button" aria-label="创作项目" title="创作项目"
              @click="emit('open-side')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2.2 4.2h11.6M2.2 8h11.6M2.2 11.8h7.4" stroke="currentColor"
                stroke-width="1.4" stroke-linecap="round" />
        </svg>
        <span>项目</span>
      </button>
      <button v-if="collapsed" class="chat-collapse" type="button" title="展开侧栏"
              aria-label="展开侧栏" @click="emit('expand')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2" stroke="currentColor"
                stroke-width="1.2" />
          <path d="M6.4 3.4v9.2" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
      <span class="col-title">{{ ws.currentProject?.title || (blank ? '' : '创作对话') }}</span>
      <span class="spacer" />
      <button v-if="hasCanvas" class="canvas-toggle" type="button" @click="emit('open-canvas')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.4" y="3.2" width="11.2" height="9.6" rx="2" stroke="currentColor"
                stroke-width="1.2" />
          <path d="M5 10.4l2-2.2 1.8 1.6 2.2-2.6" stroke="currentColor" stroke-width="1.2"
                stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>作品</span>
      </button>
    </header>

    <div ref="scroller" class="col-body img-thread" @scroll="onScroll">
      <div v-if="blank" class="img-welcome">
        <h1>今天想创作什么？</h1>
      </div>

      <template v-else>
        <div v-for="m in ws.messages" :key="m.id" class="img-msg">
          <p class="img-bubble">{{ m.content }}</p>
          <div v-if="m.kind === 'generation'" class="img-gen">
            <span class="img-gen-status" :class="`s-${m.meta?.status || 'queued'}`">
              <span v-if="isPending(m.meta)" class="spinner" />
              {{ statusText(m.meta) }}
            </span>
            <button v-if="m.meta?.version_id" class="img-gen-jump" type="button"
                    @click="ws.selectVersion(m.meta.version_id)">
              V{{ m.meta.version_no }}
              <span>查看</span>
            </button>
            <span class="img-gen-meta">
              {{ m.meta?.model_label || m.meta?.model }} · {{ m.meta?.size_label || 'A4 竖版' }} · {{ modeText(m.meta) }}
              <template v-if="m.attachments?.length"> · {{ m.attachments.length }} 张参考图</template>
            </span>
          </div>
          <p v-if="m.meta?.error" class="msg-error">{{ m.meta.error }}</p>
        </div>
        <p v-if="!ws.messages.length" class="chat-empty-hint">这个创作还没有内容，在下面描述你想要的画面。</p>
      </template>
    </div>

    <div class="img-composer-wrap">
      <div class="chat-composer img-composer">
        <div v-if="source" class="edit-state">
          <img class="edit-state-thumb" :src="source.thumb_url" :alt="`版本 ${source.version_no}`" />
          <div class="edit-state-text">
            <b>正在修改版本 V{{ source.version_no }}</b>
            <span>{{ discardSource ? '将放弃原图，按新提示重新生成' : '新结果会保存为新版本，原图与历史版本全部保留' }}</span>
          </div>
          <button class="edit-state-x" type="button" title="取消关联" aria-label="取消关联"
                  @click="ws.selectVersion('')">
            <svg viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3.6 3.6l6.8 6.8M10.4 3.6l-6.8 6.8" stroke="currentColor"
                    stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <div v-if="refs.length" class="att-strip">
          <div v-for="r in refs" :key="r.id" class="ref-item">
            <img :src="r.url" :alt="r.filename" />
            <button title="移除" @click="removeRef(r.id)">✕</button>
          </div>
        </div>

        <textarea ref="boxEl" v-model="prompt" class="chat-input img-input" rows="2"
          :placeholder="editing ? '描述你希望修改的地方…' : '描述你想生成的图片…'"
          @input="autosize" @keydown="onKeydown" />

        <div class="composer-row">
          <input ref="fileEl" type="file" accept="image/png,image/jpeg,image/webp" multiple
                 style="display:none" @change="onFiles" />
          <button class="composer-tool" type="button" :disabled="uploading" title="上传参考图"
                  @click="fileEl?.click()">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10.6 5.2L6.1 9.7a2.1 2.1 0 003 3l4.6-4.6a3.4 3.4 0 00-4.8-4.8L4 8.2a4.7 4.7 0 006.6 6.6l3.3-3.3"
                    stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
            </svg>
            <span>{{ uploading ? '上传中…' : '参考图' }}</span>
          </button>

          <div ref="modelAnchorEl" class="picker">
            <button class="picker-trigger model-trigger" :class="{ open: modelOpen }" type="button"
                    title="选择图片模型" @click="toggleModel">
              <span class="picker-value">{{ currentModelLabel }}</span><span class="caret" />
            </button>
            <Teleport to="body">
              <div v-if="modelOpen" ref="modelMenuEl" class="picker-menu model-menu"
                   :style="modelMenuStyle">
                <button v-for="m in ws.models" :key="m.id" class="picker-option"
                        :class="{ active: modelId === m.id }" type="button" @click="pickModel(m.id)">
                  <div class="picker-line">
                    <b>{{ m.label }}</b>
                    <span class="tag">{{ m.tag }}</span>
                    <span v-if="modelId === m.id" class="picker-check">✓</span>
                  </div>
                  <p class="picker-desc">{{ m.description }}</p>
                </button>
              </div>
            </Teleport>
          </div>

          <div ref="sizeAnchorEl" class="picker">
            <button class="picker-trigger size-trigger" :class="{ open: sizeOpen }" type="button"
                    title="选择纸张尺寸与画幅" @click="toggleSize">
              <span class="picker-value">{{ currentSizeLabel }}</span><span class="caret" />
            </button>
            <Teleport to="body">
              <div v-if="sizeOpen" ref="sizeMenuEl" class="picker-menu size-menu"
                   :style="sizeMenuStyle">
                <div v-for="g in sizeGroups" :key="g.label" class="picker-group">
                  <div class="picker-group-label">{{ g.label }}</div>
                  <button v-for="s in g.items" :key="s.id" class="picker-option compact"
                          :class="{ active: sizePreset === s.id }" type="button" @click="pickSize(s.id)">
                    <div class="picker-line">
                      <b>{{ s.label }}</b>
                      <span class="picker-pixels">{{ s.pixels }}</span>
                      <span v-if="sizePreset === s.id" class="picker-check">✓</span>
                    </div>
                  </button>
                </div>
              </div>
            </Teleport>
          </div>

          <span class="spec-tag" title="所有输出统一为 2K（长边 2048px）">2K</span>

          <button class="composer-send" :disabled="!canSend" :title="editing ? '提交修改' : '生成图片'"
                  aria-label="发送" @click="submit">
            <span v-if="ws.busy || ws.hasActiveJob" class="spinner" />
            <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M8 12.6V3.6M4.2 7.4L8 3.6l3.8 3.8" stroke="currentColor" stroke-width="1.6"
                    stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      <div v-if="modelOpen || sizeOpen" class="picker-scrim"
           @click="modelOpen = false; sizeOpen = false" />

      <div v-if="source" class="discard-row">
        <label>
          <input v-model="discardSource" type="checkbox" />
          放弃原图，重新生成一张（会明确标注，不伪装成修改）
        </label>
      </div>
      <div v-if="blocked" class="warning-strip">
        <b>该模型不支持基于原图修改。</b>
        <span>请换用支持编辑的模型，或勾选「放弃原图，重新生成一张」。</span>
      </div>
      <div v-if="localError || ws.error" class="form-error">{{ localError || ws.error }}</div>
    </div>
  </section>
</template>
