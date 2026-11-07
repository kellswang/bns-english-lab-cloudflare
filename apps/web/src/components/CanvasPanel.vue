<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useWorkspace } from '../stores/workspace'
import { fmtDateTime } from '../utils/datetime'

const emit = defineEmits<{
  (e: 'notice', text: string): void
  (e: 'close'): void
}>()
const ws = useWorkspace()
const v = computed(() => ws.selectedVersion)
const zoomOpen = ref(false)
const railEl = ref<HTMLElement | null>(null)

const pending = computed(() => {
  if (ws.versions.length) return false
  if (ws.hasActiveJob) return true
  // 刷新后 job 可能已结束但消息仍是进行中状态，这里一并视为等待
  const s = ws.messages[ws.messages.length - 1]?.meta?.status
  return !!s && !['succeeded', 'failed', 'uncertain', 'interrupted'].includes(s)
})
const lastFailed = computed(() => {
  const s = ws.messages[ws.messages.length - 1]?.meta?.status
  return s === 'failed' || s === 'uncertain' || s === 'interrupted'
})
const versionLabel = computed(() => (v.value ? `版本 ${String(v.value.version_no).padStart(2, '0')}` : '作品预览'))
const createdText = computed(() => (v.value?.created_at ? fmtDateTime(v.value.created_at, { year: true }) : ''))

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') zoomOpen.value = false
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

/** 切换版本时把对应缩略图滚进可视区 */
watch(() => ws.selectedVersionId, async () => {
  await nextTick()
  const active = railEl.value?.querySelector<HTMLElement>('.v-thumb.active')
  active?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
})
</script>

<template>
  <section class="col col-right artifact">
    <header class="artifact-bar">
      <div class="artifact-title">
        <b>{{ versionLabel }}</b>
        <span v-if="v" class="artifact-sub">{{ v.params?.size_label || 'A4 竖版' }} · 2K</span>
        <span v-else-if="pending" class="artifact-sub">正在生成…</span>
      </div>
      <span class="spacer" />
      <div v-if="v" class="artifact-tools">
        <button class="icon-btn tool-btn" type="button" title="放大查看" aria-label="放大查看"
                @click="zoomOpen = true">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7.2" cy="7.2" r="4.3" stroke="currentColor" stroke-width="1.3" />
            <path d="M10.4 10.4L13.6 13.6" stroke="currentColor" stroke-width="1.3"
                  stroke-linecap="round" />
            <path d="M5.6 7.2h3.2M7.2 5.6v3.2" stroke="currentColor" stroke-width="1.2"
                  stroke-linecap="round" />
          </svg>
        </button>
        <a class="icon-btn tool-btn" :href="ws.downloadUrl(v.id)" title="下载 PNG" aria-label="下载 PNG">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3v7M5.2 7.4L8 10.2l2.8-2.8" stroke="currentColor" stroke-width="1.3"
                  stroke-linecap="round" stroke-linejoin="round" />
            <path d="M3.2 12.2h9.6" stroke="currentColor" stroke-width="1.3"
                  stroke-linecap="round" />
          </svg>
        </a>
        <button class="icon-btn artifact-close" type="button" title="收起作品" aria-label="收起作品"
                @click="emit('close')">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor"
                  stroke-width="1.4" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </header>

    <div class="artifact-stage">
      <div v-if="v" class="artifact-canvas">
        <img :src="v.url" :alt="`版本 ${v.version_no}`" class="artifact-image"
             @click="zoomOpen = true" />
      </div>
      <div v-else-if="pending" class="artifact-waiting">
        <span class="spinner" />
        <p>正在生成第一张图片…</p>
        <span>通常需要 20–60 秒，可以回到左侧继续补充描述。</span>
      </div>
      <div v-else class="artifact-waiting">
        <p>{{ lastFailed ? '本次没有生成成功' : '这个创作还没有图片' }}</p>
        <span>{{ lastFailed ? '在左侧调整描述后再试一次，或换用另一个模型。' : '在左侧描述想要的画面，第一张作品会出现在这里。' }}</span>
      </div>
    </div>

    <div v-if="ws.versions.length" ref="railEl" class="v-rail">
      <button v-for="item in ws.versions" :key="item.id" type="button"
              class="v-thumb" :class="{ active: ws.selectedVersionId === item.id }"
              :title="`V${item.version_no} · ${item.mode === 'edit' ? '基于原图修改' : '全新生成'}`"
              @click="ws.selectVersion(item.id)">
        <span class="v-thumb-img"><img :src="item.thumb_url" :alt="`V${item.version_no}`" /></span>
        <span class="v-thumb-no">V{{ item.version_no }}</span>
      </button>
    </div>

    <p v-if="v && createdText" class="artifact-foot">{{ createdText }} · 共 {{ ws.versions.length }} 个版本</p>

    <div v-if="zoomOpen && v" class="img-lightbox" @click.self="zoomOpen = false">
      <img :src="v.url" :alt="`版本 ${v.version_no}`" />
      <button class="img-lightbox-x" type="button" title="关闭" aria-label="关闭"
              @click="zoomOpen = false">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" stroke="currentColor"
                stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </section>
</template>
