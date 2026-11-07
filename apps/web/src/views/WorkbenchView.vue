<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { useWorkspace } from '../stores/workspace'
import { useChat } from '../stores/chat'
import ProjectsPanel from '../components/ProjectsPanel.vue'
import ConversationPanel from '../components/ConversationPanel.vue'
import CanvasPanel from '../components/CanvasPanel.vue'
import ChatPanel from '../components/chat/ChatPanel.vue'
import AdminPanel from '../components/AdminPanel.vue'
import ModeSwitch from '../components/ModeSwitch.vue'

const auth = useAuthStore()
const ws = useWorkspace()
const chat = useChat()
const router = useRouter()
const booting = ref(true)
const notice = ref('')
let noticeTimer: number | undefined

type Mode = 'chat' | 'image'
const isAdmin = computed(() => auth.user?.role === 'admin')
// 管理页不是工作模式，而是右上角进入的独立面板
const adminOpen = ref(false)
const saved = localStorage.getItem('bns_work_mode')
const mode = ref<Mode>(saved === 'image' ? 'image' : 'chat')

// 生图工作区：空白态（标题 + 输入框）/ 创作态（对话 + 作品）
const imgSideCollapsed = ref(localStorage.getItem('bns_img_side') === '1')
const imgSideOpen = ref(false)
const imgCanvasOpen = ref(false)
const imgBlank = computed(() =>
  !ws.currentId
    ? true
    : ws.messages.length === 0 && ws.versions.length === 0 && !ws.hasActiveJob,
)

function toggleImgSide() {
  imgSideCollapsed.value = !imgSideCollapsed.value
  localStorage.setItem('bns_img_side', imgSideCollapsed.value ? '1' : '0')
}

// 窄屏作品预览是浮层：新版本出来时自动打开一次，让老师直接看到结果
watch(() => ws.versions.length, (n, prev) => {
  if (n > (prev || 0) && window.matchMedia?.('(max-width: 1100px)').matches) {
    imgCanvasOpen.value = true
  }
})
watch(() => ws.currentId, () => { imgCanvasOpen.value = false })

// 校内邮箱验证通过即自动开通，只有被管理员明确停用的账号才拦截
const blocked = computed(() => auth.user && auth.user.status === 'suspended')
const amountText = computed(() => `$${(ws.usage.total_usd ?? ws.usage.amount_usd).toFixed(2)}`)
const usageTitle = computed(() => {
  const chatPending = ws.usage.chat_pending ?? 0
  const chatAmount = ws.usage.chat_amount_usd ?? 0
  const pending = chatPending ? `；另有 ${chatPending} 条对话费用待上游核对` : ''
  return `累计消费 = 图片 $${ws.usage.amount_usd.toFixed(2)} + 已核对对话 $${chatAmount.toFixed(4)}${pending}。图片按站内固定单价估算，对话按上游实际账单，仅供校内统计。`
})

function toast(text: string) {
  notice.value = text
  if (noticeTimer) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => { notice.value = '' }, 3200)
}

function switchMode(next: Mode) {
  adminOpen.value = false
  imgCanvasOpen.value = false
  mode.value = next
  localStorage.setItem('bns_work_mode', next)
}

function toggleAdmin() {
  if (!isAdmin.value) return
  adminOpen.value = !adminOpen.value
}

async function logout() {
  await auth.logout()
  await router.replace('/login')
}
function reload() { window.location.reload() }

onMounted(async () => {
  await auth.ready()
  // 顶栏品牌名来自本年级实例配置
  auth.loadConfig().catch(() => {})
  if (blocked.value) { booting.value = false; return }
  try {
    await Promise.all([ws.loadModels(), ws.loadProjects(), ws.loadUsage()])
    if (!ws.currentId && ws.projects.length) await ws.openProject(ws.projects[0].id)
    await ws.resumeJobs()
    // 对话数据按需加载，失败不影响图片工作台
    try {
      await chat.loadModels()
      await chat.loadConversations()
    } catch (e: any) {
      toast(e?.message || '对话模块初始化失败')
    }
  } catch (e: any) {
    toast(e?.message || '初始化失败')
  } finally { booting.value = false }
})
</script>

<template>
  <div>
    <header class="topbar">
      <div class="topbar-brand">
        <div class="topbar-mark">B</div>
        <span class="topbar-name">{{ auth.appName || '英语教研平台' }}</span>
      </div>

      <div class="topbar-center">
        <ModeSwitch :model-value="mode" @update:model-value="switchMode" />
      </div>

      <div class="topbar-right">
        <button v-if="isAdmin" class="admin-entry" :class="{ active: adminOpen }"
                type="button" :aria-pressed="adminOpen" @click="toggleAdmin">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M8 2.6l4.6 2.2v3.3c0 2.7-1.9 4.6-4.6 5.3-2.7-.7-4.6-2.6-4.6-5.3V4.8L8 2.6z"
                  stroke="currentColor" stroke-width="1.2" />
            <path d="M6.1 8.1l1.3 1.3 2.5-2.6" stroke="currentColor" stroke-width="1.3"
                  stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="admin-label">管理</span>
        </button>
        <div class="usage" :title="usageTitle">
          <b>{{ auth.user?.display_name }}</b>
          <span class="usage-sep">·</span>
          <b>{{ amountText }}</b>
        </div>
        <button class="btn btn-sm btn-ghost logout-btn" @click="logout">退出</button>
      </div>
    </header>

    <div v-if="booting" class="center-state">
      <div class="box"><span class="spinner" /><p style="margin-top:16px">正在进入工作台…</p></div>
    </div>

    <div v-else-if="blocked" class="center-state">
      <div class="box">
        <p class="eyebrow">账号状态</p>
        <h1>账号已停用</h1>
        <p>请联系管理员恢复访问权限。</p>
        <div style="margin-top:28px;display:flex;gap:10px;justify-content:center">
          <button class="btn" @click="reload">刷新状态</button>
          <button class="btn btn-ghost" @click="logout">退出登录</button>
        </div>
      </div>
    </div>

    <template v-else>
      <!-- 工作模式与状态各自保留：切换只是显示/隐藏，不卸载组件 -->
      <main v-show="!adminOpen && mode === 'chat'" class="workbench chat-workbench">
        <ChatPanel @notice="toast" />
      </main>
      <main v-show="!adminOpen && mode === 'image'" class="workbench img-workbench"
            :class="{ 'is-blank': imgBlank, 'side-collapsed': imgSideCollapsed, 'canvas-open': imgCanvasOpen }">
        <div v-if="imgSideOpen" class="chat-side-scrim" @click="imgSideOpen = false" />
        <ProjectsPanel :class="{ open: imgSideOpen }" @notice="toast" @collapse="toggleImgSide" />
        <ConversationPanel :blank="imgBlank" :collapsed="imgSideCollapsed" :has-canvas="!imgBlank"
                           @notice="toast" @expand="toggleImgSide" @open-side="imgSideOpen = true"
                           @open-canvas="imgCanvasOpen = true" />
        <CanvasPanel v-if="!imgBlank" @notice="toast" @close="imgCanvasOpen = false" />
      </main>
      <main v-if="isAdmin && adminOpen" class="workbench admin-workbench">
        <AdminPanel @notice="toast" />
      </main>
    </template>

    <div v-if="notice" class="toast">{{ notice }}</div>
  </div>
</template>
