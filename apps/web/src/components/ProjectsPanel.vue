<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { useWorkspace } from '../stores/workspace'

const emit = defineEmits<{
  (e: 'notice', text: string): void
  (e: 'collapse'): void
}>()
const ws = useWorkspace()
const menuId = ref<string | null>(null)
const renameId = ref<string | null>(null)
const renameValue = ref('')
const renameEl = ref<HTMLInputElement | null>(null)
const confirmDelete = ref<string | null>(null)
let searchTimer: number | undefined

function onSearch() {
  if (searchTimer) window.clearTimeout(searchTimer)
  searchTimer = window.setTimeout(() => void ws.loadProjects(), 220)
}

function setRenameEl(el: unknown, id: string) {
  if (renameId.value === id) renameEl.value = (el as HTMLInputElement) || null
}

/** 新建创作：只在本地开一个空白创作，发出第一条请求时才落库 */
function newProject() {
  ws.newDraft()
  menuId.value = null
  confirmDelete.value = null
}

async function startRename(id: string, title: string) {
  menuId.value = null
  renameId.value = id
  renameValue.value = title
  await nextTick(); renameEl.value?.focus(); renameEl.value?.select()
}
async function commitRename() {
  if (!renameId.value) return
  const v = renameValue.value.trim()
  if (v) {
    try { await ws.patchProject(renameId.value, { title: v }) }
    catch (e: any) { emit('notice', e?.message || '重命名失败') }
  }
  renameId.value = null
}
async function doDelete(id: string) {
  confirmDelete.value = null
  menuId.value = null
  try { await ws.deleteProject(id); emit('notice', '项目已删除') }
  catch (e: any) { emit('notice', e?.message || '删除失败') }
}
</script>

<template>
  <aside class="chat-side project-side">
    <div class="side-top">
      <button class="side-new" type="button" @click="newProject">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3.2v9.6M3.2 8h9.6" stroke="currentColor" stroke-width="1.4"
                stroke-linecap="round" />
        </svg>
        <span>新建创作</span>
      </button>
      <button class="side-collapse" type="button" title="收起侧栏" aria-label="收起侧栏"
              @click="emit('collapse')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2" stroke="currentColor"
                stroke-width="1.2" />
          <path d="M6.4 3.4v9.2" stroke="currentColor" stroke-width="1.2" />
        </svg>
      </button>
    </div>

    <div class="chat-search">
      <input v-model="ws.search" class="input" placeholder="搜索创作项目" @input="onSearch" />
    </div>

    <div class="chat-list">
      <template v-if="ws.projects.length">
        <p class="chat-group-label">最近创作</p>
        <div v-for="p in ws.projects" :key="p.id" class="chat-item"
             :class="{ active: ws.currentId === p.id }">
          <template v-if="renameId === p.id">
            <input :ref="(el) => setRenameEl(el, p.id)" v-model="renameValue" class="input rename-input"
                   @keyup.enter="commitRename" @blur="commitRename" @keyup.esc="renameId = null" />
          </template>
          <template v-else>
            <button class="chat-item-main" :title="p.title" @click="ws.openProject(p.id)">
              <span class="chat-item-title">{{ p.title }}</span>
            </button>
            <button class="chat-item-more" type="button" title="更多"
                    @click.stop="menuId = menuId === p.id ? null : p.id; confirmDelete = null">
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="3.4" cy="8" r="1.15" /><circle cx="8" cy="8" r="1.15" />
                <circle cx="12.6" cy="8" r="1.15" />
              </svg>
            </button>
            <div v-if="menuId === p.id" class="menu chat-menu" @click.stop>
              <template v-if="confirmDelete === p.id">
                <p class="menu-confirm-text">确认删除「{{ p.title }}」？</p>
                <div class="menu-confirm-actions">
                  <button class="danger" @click="doDelete(p.id)">确认删除</button>
                  <button @click="confirmDelete = null">取消</button>
                </div>
              </template>
              <template v-else>
                <button @click="startRename(p.id, p.title)">重命名</button>
                <template v-if="p.permission === 'owner'">
                  <hr />
                  <button class="danger" @click="confirmDelete = p.id">删除项目</button>
                </template>
              </template>
            </div>
          </template>
        </div>
      </template>
      <p v-else-if="ws.loading" class="chat-empty-hint">载入中…</p>
      <p v-else class="chat-empty-hint">
        {{ ws.search ? '没有匹配的项目。' : '还没有创作。在右侧描述你想要的画面，第一次生成后会自动保存到这里。' }}
      </p>
    </div>
  </aside>
</template>
