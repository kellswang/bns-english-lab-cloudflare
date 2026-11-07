<script setup lang="ts">
/** 管理页（仅 admin）：账户消费汇总 + 操作日志。只读，不提供任何写操作。 */
import { computed, onMounted, ref } from 'vue'
import { useAdmin } from '../stores/admin'
import { fmtDateTime } from '../utils/datetime'
import type { AdminUserUsage } from '../types'

const emit = defineEmits<{ (e: 'notice', text: string): void }>()

const admin = useAdmin()
const error = ref('')

const ACTION_LABELS: Record<string, string> = {
  login: '登录',
  'chat.create': '新建对话',
  'chat.delete': '删除对话',
  upload_reference: '上传参考图',
  generate: '生成图片',
  project_create: '新建项目',
  project_update: '更新项目',
  project_delete: '删除项目',
  version_star: '收藏版本',
}

const totals = computed(() => admin.overview?.totals)
const users = computed(() => admin.overview?.users ?? [])
const hasMore = computed(() => admin.logs.length < admin.total)

function actionLabel(a: string) { return ACTION_LABELS[a] || a }

function fmtUsd(n: number | undefined, digits = 2): string {
  return `$${(n ?? 0).toFixed(digits)}`
}

function accountLabel(u: AdminUserUsage): string {
  return `${u.display_name}（${u.email}）`
}

async function onFilterChange() {
  try { await admin.loadLogs() } catch (e: any) {
    emit('notice', e?.message || '日志加载失败')
  }
}

function toggleAccount(email: string) {
  admin.filterByAccount(email).catch((e: any) => emit('notice', e?.message || '日志加载失败'))
}

async function refresh() {
  error.value = ''
  try { await admin.init() } catch (e: any) {
    error.value = e?.status === 403 ? '仅管理员可访问此页面' : (e?.message || '加载失败')
  }
}

onMounted(refresh)
</script>

<template>
  <div class="admin-shell">
    <div class="admin-scroll">
      <div v-if="error" class="empty">{{ error }}</div>

      <template v-else>
        <!-- 汇总 -->
        <section class="admin-card">
          <div class="admin-card-head">
            <h2>全站汇总</h2>
            <span class="muted" style="font-size: 11.5px">
              单价 {{ fmtUsd(admin.overview?.unit_price_usd) }}/张 · 图片按站内固定单价估算，对话按上游已核对金额累加
            </span>
          </div>
          <div class="admin-stats">
            <div class="admin-stat">
              <span class="eyebrow">账户</span>
              <b class="mono">{{ totals?.users ?? '—' }}</b>
            </div>
            <div class="admin-stat">
              <span class="eyebrow">图片（张）</span>
              <b class="mono">{{ totals?.images ?? '—' }}</b>
            </div>
            <div class="admin-stat">
              <span class="eyebrow">图片消费</span>
              <b class="mono">{{ totals ? fmtUsd(totals.image_amount_usd) : '—' }}</b>
            </div>
            <div class="admin-stat">
              <span class="eyebrow">对话消费</span>
              <b class="mono">{{ totals ? fmtUsd(totals.chat_amount_usd, 4) : '—' }}</b>
            </div>
            <div class="admin-stat accent">
              <span class="eyebrow">合计</span>
              <b class="mono">{{ totals ? fmtUsd(totals.total_usd) : '—' }}</b>
              <span v-if="totals?.chat_pending" class="muted" style="font-size: 11px">
                另有 {{ totals.chat_pending }} 条对话费用待核对
              </span>
            </div>
          </div>
        </section>

        <!-- 账户 -->
        <section class="admin-card">
          <div class="admin-card-head">
            <h2>各账户用量</h2>
            <span class="muted" style="font-size: 11.5px">点击账户行可筛选下方日志</span>
          </div>
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>姓名</th><th>邮箱</th><th>角色</th><th>状态</th>
                  <th>最近登录</th>
                  <th class="num">图片（张）</th><th class="num">图片</th>
                  <th class="num">对话</th><th class="num">合计</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="u in users" :key="u.id"
                    :class="{ picked: admin.filterEmail === u.email }"
                    @click="toggleAccount(u.email)">
                  <td>{{ u.display_name }}</td>
                  <td class="muted">{{ u.email }}</td>
                  <td>
                    <span class="tag" :class="u.role === 'admin' ? 'tag-accent' : ''">
                      {{ u.role === 'admin' ? '管理员' : '教师' }}
                    </span>
                  </td>
                  <td>
                    <span class="muted">{{ u.status === 'active' ? '正常' : u.status }}</span>
                  </td>
                  <td class="muted mono">{{ fmtDateTime(u.last_login_at) }}</td>
                  <td class="num mono">{{ u.images }}</td>
                  <td class="num mono">{{ fmtUsd(u.image_amount_usd) }}</td>
                  <td class="num mono">
                    {{ fmtUsd(u.chat_amount_usd, 4) }}<template v-if="u.chat_pending"> +{{ u.chat_pending }}待核</template>
                  </td>
                  <td class="num mono"><b>{{ fmtUsd(u.total_usd) }}</b></td>
                </tr>
                <tr v-if="!users.length"><td colspan="9" class="empty">暂无账户</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- 操作日志 -->
        <section class="admin-card">
          <div class="admin-card-head">
            <h2>操作日志</h2>
            <div class="admin-filters">
              <select v-model="admin.filterEmail" class="select" @change="onFilterChange">
                <option value="">全部账户</option>
                <option v-for="u in users" :key="u.id" :value="u.email">{{ accountLabel(u) }}</option>
              </select>
              <select v-model="admin.filterAction" class="select" @change="onFilterChange">
                <option value="">全部动作</option>
                <option v-for="a in admin.actions" :key="a" :value="a">{{ actionLabel(a) }}</option>
              </select>
              <button class="btn btn-sm" @click="onFilterChange">刷新</button>
            </div>
          </div>
          <div class="admin-table-wrap">
            <table class="admin-table">
              <thead>
                <tr><th>时间</th><th>姓名</th><th>动作</th><th>详情</th><th>来源 IP</th></tr>
              </thead>
              <tbody>
                <tr v-for="item in admin.logs" :key="item.id">
                  <td class="mono muted">{{ fmtDateTime(item.created_at) }}</td>
                  <td>{{ item.actor_name || '—' }}<div class="muted" style="font-size:10.5px">{{ item.actor_email }}</div></td>
                  <td><span class="tag">{{ actionLabel(item.action) }}</span></td>
                  <td class="muted admin-detail">{{ item.detail || item.entity_id || '—' }}</td>
                  <td class="mono muted">{{ item.ip || '—' }}</td>
                </tr>
                <tr v-if="!admin.logs.length && !admin.loading">
                  <td colspan="5" class="empty">暂无日志</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="admin.loading" class="loading-line" style="margin:12px 0" />
          <div v-if="hasMore" class="admin-more">
            <span class="muted" style="font-size:11.5px">已显示 {{ admin.logs.length }} / {{ admin.total }} 条</span>
            <button class="btn btn-sm" :disabled="admin.loadingMore" @click="admin.loadMore()">
              {{ admin.loadingMore ? '加载中…' : '加载更多' }}
            </button>
          </div>
        </section>
      </template>
    </div>
  </div>
</template>

<style scoped>
.admin-shell { height: 100%; display: block; background: var(--bg); }
.admin-scroll { height: 100%; overflow-y: auto; padding: 26px 30px 48px;
  max-width: 1120px; margin: 0 auto; }
.admin-card { background: var(--surface); border: 1px solid var(--line);
  border-radius: 10px; padding: 18px 20px 8px; margin-bottom: 18px; }
.admin-card-head { display: flex; align-items: baseline; justify-content: space-between;
  gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
.admin-card-head h2 { font-size: 13.5px; font-weight: 600; letter-spacing: -.01em; }
.admin-stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.admin-stat { flex: 1; min-width: 128px; background: var(--surface-2);
  border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; }
.admin-stat b { font-size: 19px; font-weight: 600; }
.admin-stat.accent { background: var(--accent-soft); border: 1px solid #EBCCBE; }
.admin-stat.accent b { color: var(--accent-ink); }
.admin-table-wrap { overflow-x: auto; margin: 0 -4px 12px; }
.admin-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.admin-table th { text-align: left; font-size: 10.5px; letter-spacing: .06em;
  color: var(--muted); font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--line);
  white-space: nowrap; }
.admin-table td { padding: 9px 10px; border-bottom: 1px solid var(--line-soft);
  vertical-align: top; }
.admin-table tbody tr { cursor: pointer; }
.admin-table tbody tr:hover { background: var(--surface-2); }
.admin-table tbody tr.picked { background: var(--surface-3); }
.admin-table .num { text-align: right; white-space: nowrap; }
.admin-detail { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.admin-filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.admin-more { display: flex; align-items: center; justify-content: center; gap: 12px;
  padding: 4px 0 12px; }
</style>
