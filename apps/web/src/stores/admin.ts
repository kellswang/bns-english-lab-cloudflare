/** 管理页数据：账户消费汇总 + 操作日志（只读，仅 admin 可访问）。 */
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api/client'
import type { AdminLogItem, AdminLogsResponse, AdminOverview } from '../types'

const PAGE = 100

export const useAdmin = defineStore('admin', () => {
  const overview = ref<AdminOverview | null>(null)
  const logs = ref<AdminLogItem[]>([])
  const total = ref(0)
  const actions = ref<string[]>([])
  const loading = ref(false)
  const loadingMore = ref(false)
  const filterEmail = ref('')
  const filterAction = ref('')

  function queryUrl(offset: number) {
    const p = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    if (filterEmail.value) p.set('email', filterEmail.value)
    if (filterAction.value) p.set('action', filterAction.value)
    return `/api/v1/admin/logs?${p.toString()}`
  }

  async function loadOverview() {
    overview.value = await api.get<AdminOverview>('/api/v1/admin/overview')
  }

  async function loadLogs() {
    loading.value = true
    try {
      const d = await api.get<AdminLogsResponse>(queryUrl(0))
      logs.value = d.items
      total.value = d.total
      actions.value = d.actions
    } finally {
      loading.value = false
    }
  }

  async function loadMore() {
    if (loadingMore.value || logs.value.length >= total.value) return
    loadingMore.value = true
    try {
      const d = await api.get<AdminLogsResponse>(queryUrl(logs.value.length))
      logs.value.push(...d.items)
      total.value = d.total
    } finally {
      loadingMore.value = false
    }
  }

  async function init() {
    await Promise.all([loadOverview(), loadLogs()])
  }

  function filterByAccount(email: string) {
    filterEmail.value = filterEmail.value === email ? '' : email
    return loadLogs()
  }

  function reset() {
    filterEmail.value = ''
    filterAction.value = ''
    logs.value = []
    total.value = 0
    actions.value = []
    overview.value = null
  }

  return {
    overview, logs, total, actions, loading, loadingMore,
    filterEmail, filterAction,
    init, loadOverview, loadLogs, loadMore, filterByAccount, reset,
  }
})
