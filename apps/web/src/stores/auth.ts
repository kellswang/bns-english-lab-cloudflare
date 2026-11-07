import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '../api/client'
import type { User } from '../types'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const initialized = ref(false)
  // 年级实例配置来自服务端(/auth/config),前端不硬编码任何学校域名
  const emailDomain = ref('')
  const appName = ref('')
  let pending: Promise<void> | null = null
  let configPending: Promise<void> | null = null

  async function ready() {
    if (initialized.value) return
    if (!pending) {
      pending = api.get<User>('/api/v1/auth/me')
        .then((d) => { user.value = d })
        .catch(() => { user.value = null })
        .finally(() => { initialized.value = true; pending = null })
    }
    return pending
  }

  async function loadConfig() {
    if (emailDomain.value) return
    if (!configPending) {
      configPending = api.get<{ email_domain: string; app_name: string }>('/api/v1/auth/config')
        .then((d) => {
          emailDomain.value = d.email_domain
          appName.value = d.app_name
        })
        .catch(() => { emailDomain.value = '' })
        .finally(() => { configPending = null })
    }
    return configPending
  }

  async function requestCode(email: string) {
    return api.post<{ email: string; expires_in: number; resend_after: number; dev_code?: string }>(
      '/api/v1/auth/email/code', { email },
    )
  }

  async function verifyCode(email: string, code: string, remember = true) {
    user.value = await api.post<User>('/api/v1/auth/email/verify', {
      email, code, trust_device: remember,
    })
    initialized.value = true
    return user.value
  }

  async function logout() {
    try { await api.post('/api/v1/auth/logout') } finally { user.value = null }
  }

  return { user, initialized, emailDomain, appName, ready, loadConfig, requestCode, verifyCode, logout }
})
