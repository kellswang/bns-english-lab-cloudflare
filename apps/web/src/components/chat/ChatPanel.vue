<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useChat } from '../../stores/chat'
import type { ChatConversationSummary } from '../../types'
import ChatComposer from './ChatComposer.vue'
import { parseServerTime } from '../../utils/datetime'
import MessageBlock from './MessageBlock.vue'

const chat = useChat()
const scroller = ref<HTMLElement | null>(null)
const composerRef = ref<InstanceType<typeof ChatComposer> | null>(null)
const atBottom = ref(true)
const menuId = ref<string | null>(null)
const renamingId = ref<string | null>(null)
const renameValue = ref('')
const renameEl = ref<HTMLInputElement | null>(null)

// 新对话首页：只有欢迎标题 + 输入框，没有快捷入口
const isEmpty = computed(() => chat.visibleMessages.length === 0)

// 侧栏折叠（宽屏）：记住上次选择
const collapsed = ref(localStorage.getItem('bns_chat_side') === '1')
// 窄屏（≤1080px）时历史侧栏改为抽屉
const sideOpen = ref(false)
const narrowNow = () => !!window.matchMedia?.('(max-width: 1080px)').matches

function toggleCollapse() {
  collapsed.value = !collapsed.value
  localStorage.setItem('bns_chat_side', collapsed.value ? '1' : '0')
}

/** 历史对话按时间分组：今天 / 昨天 / 近 7 天 / 更早 */
const groups = computed(() => {
  const buckets: { label: string; items: ChatConversationSummary[] }[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '过去 7 天', items: [] },
    { label: '更早', items: [] },
  ]
  const day = 86_400_000
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const d0 = start.getTime()
  for (const c of chat.conversations) {
    const t = parseServerTime(c.updated_at)
    if (!Number.isFinite(t) || t < d0 - 6 * day) buckets[3].items.push(c)
    else if (t >= d0) buckets[0].items.push(c)
    else if (t >= d0 - day) buckets[1].items.push(c)
    else buckets[2].items.push(c)
  }
  return buckets.filter((b) => b.items.length)
})

async function openConversation(id: string) {
  await chat.openConversation(id)
  if (narrowNow()) sideOpen.value = false
}

const modelLabelOf = (id: string | null) => chat.models.find((m) => m.id === id)?.label || ''

function siblings(msgId: string): { index: number; total: number } {
  const m = chat.messages.find((x) => x.id === msgId)
  if (!m) return { index: 1, total: 1 }
  const sibs = chat.messages.filter((x) => x.parent_id === m.parent_id && x.role === m.role)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
  return { index: Math.max(1, sibs.findIndex((x) => x.id === msgId) + 1), total: Math.max(1, sibs.length) }
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

function scrollToBottom(force = false) {
  const el = scroller.value
  if (!el) return
  if (force || atBottom.value) el.scrollTop = el.scrollHeight
}

watch(() => chat.messages.length, async () => { await nextTick(); scrollToBottom() })
watch(() => chat.messages.map((m) => m.content).join(''), async () => {
  await nextTick(); scrollToBottom()
})
watch(() => chat.currentId, async () => { await nextTick(); scrollToBottom(true) })

onMounted(async () => {
  if (!chat.models.length) await chat.loadModels()
  await chat.loadConversations()
  // 打开页面停在新对话首页；历史记录在左侧栏自行选择
})

/** 新对话：只在本地清空，不落库；发出第一条消息时才创建会话 */
async function newChat() {
  chat.startNewChat()
  if (narrowNow()) sideOpen.value = false
  await nextTick()
  composerRef.value?.focus()
}

function startRename(id: string, title: string) {
  renamingId.value = id
  renameValue.value = title
  menuId.value = null
  nextTick(() => renameEl.value?.focus())
}

async function commitRename() {
  const id = renamingId.value
  if (!id) return
  const v = renameValue.value.trim()
  renamingId.value = null
  if (v) await chat.renameConversation(id, v)
}

async function removeConversation(id: string) {
  menuId.value = null
  await chat.deleteConversation(id)
}
</script>

<template>
  <div class="chat-shell" :class="{ 'side-collapsed': collapsed }">
    <div v-if="sideOpen" class="chat-side-scrim" @click="sideOpen = false" />
    <aside class="chat-side" :class="{ open: sideOpen }">
      <div class="side-top">
        <button class="side-new" type="button" @click="newChat">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.4"
                  stroke-linecap="round" />
          </svg>
          <span>新对话</span>
        </button>
        <button class="side-collapse" type="button" title="收起侧栏" aria-label="收起侧栏"
                @click="toggleCollapse">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2" stroke="currentColor"
                  stroke-width="1.2" />
            <path d="M6.4 3.4v9.2" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </div>

      <div class="chat-search">
        <input v-model="chat.search" class="input" placeholder="搜索历史对话"
               @input="chat.loadConversations()" />
      </div>

      <div class="chat-list">
        <template v-for="g in groups" :key="g.label">
          <p class="chat-group-label">{{ g.label }}</p>
          <div v-for="c in g.items" :key="c.id" class="chat-item"
               :class="{ active: chat.currentId === c.id }">
            <template v-if="renamingId === c.id">
              <input ref="renameEl" v-model="renameValue" class="input rename-input"
                     @keydown.enter="commitRename" @keydown.esc="renamingId = null" @blur="commitRename" />
            </template>
            <template v-else>
              <button class="chat-item-main" :title="c.title" @click="openConversation(c.id)">
                <span class="chat-item-title">{{ c.title }}</span>
              </button>
              <button class="chat-item-more" type="button" title="更多"
                      @click.stop="menuId = menuId === c.id ? null : c.id">
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <circle cx="3.4" cy="8" r="1.15" /><circle cx="8" cy="8" r="1.15" />
                  <circle cx="12.6" cy="8" r="1.15" />
                </svg>
              </button>
              <div v-if="menuId === c.id" class="menu chat-menu" @click.stop>
                <button @click="startRename(c.id, c.title)">重命名</button>
                <hr />
                <button class="danger" @click="removeConversation(c.id)">删除对话</button>
              </div>
            </template>
          </div>
        </template>
        <p v-if="!chat.conversations.length" class="chat-empty-hint">
          还没有对话记录，直接在输入框里提出问题即可；对话会自动保存在这里。
        </p>
      </div>
    </aside>

    <section class="chat-main" :class="{ 'is-empty': isEmpty }">
      <header class="chat-head">
        <button class="chat-side-toggle" type="button" :aria-expanded="sideOpen"
                aria-label="历史对话" title="历史对话" @click="sideOpen = !sideOpen">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2.2 4.2h11.6M2.2 8h11.6M2.2 11.8h7.4" stroke="currentColor"
                  stroke-width="1.4" stroke-linecap="round" />
          </svg>
          <span>历史</span>
        </button>
        <button v-if="collapsed" class="chat-collapse" type="button"
                title="展开侧栏" aria-label="展开侧栏" @click="toggleCollapse">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2" stroke="currentColor"
                  stroke-width="1.2" />
            <path d="M6.4 3.4v9.2" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
        <h2>{{ chat.current?.title || '新对话' }}</h2>
        <span class="chat-head-meta">
          {{ chat.currentModel?.label }}<template v-if="chat.thinkingLevels.find(l => l.id === chat.thinking)">
            · {{ chat.thinkingLevels.find(l => l.id === chat.thinking)?.label }}</template>
        </span>
      </header>

      <div class="chat-body">
        <div ref="scroller" class="chat-scroll" @scroll="onScroll">
          <div v-if="isEmpty" class="chat-welcome">
            <h1>今天想准备什么？</h1>
            <p v-if="chat.currentModel && chat.currentModel.status !== 'ok'" class="chat-warn">
              当前模型不可用：{{ chat.currentModel.status_reason }}
            </p>
          </div>

          <div v-else class="chat-thread">
            <MessageBlock v-for="m in chat.visibleMessages" :key="m.id" :msg="m"
                          :model-label="modelLabelOf(m.model)"
                          :branch-index="siblings(m.id).index"
                          :branch-total="siblings(m.id).total"
                          :streaming="chat.streaming"
                          @regenerate="chat.regenerate"
                          @edit="(id, text) => chat.editAndResend(id, text)"
                          @branch="chat.activateBranch" />
            <p v-if="chat.error" class="chat-error">{{ chat.error }}</p>
          </div>
        </div>

        <ChatComposer ref="composerRef" />
      </div>
    </section>
  </div>
</template>
