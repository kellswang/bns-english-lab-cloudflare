<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import LoginVisual from '../components/LoginVisual.vue'

/**
 * 与段考成绩录入系统一致的邮箱验证码登录：
 *   输入姓名全拼 → 发送验证码 → 原地展开 6 格验证码 → 登录
 * 不跳转、不弹窗、不切换页面。校内邮箱域名由服务端 /auth/config 下发
 * (每年级实例独立配置),服务端仍会强校验域名。
 */
const auth = useAuthStore()
const emailDomain = ref('')
const EMAIL_DOMAIN = computed(() => emailDomain.value)
const fullEmail = computed(() => `${localPart.value}@${EMAIL_DOMAIN.value}`)

const stage = ref<'email' | 'code'>('email')
const localPart = ref('')
const codeDigits = ref<string[]>(['', '', '', '', '', ''])
const code = computed(() => codeDigits.value.join(''))
const sending = ref(false)
const verifying = ref(false)
const emailError = ref('')
const codeError = ref('')
const codeHint = ref('')
const devCode = ref('')
const shaking = ref(false)
const notInvited = ref(false)

// 「记住这台设备」：默认勾选，30 天内免验证码；只存开关本身，不存任何凭据
const REMEMBER_KEY = 'bns_remember_device'
const LAST_EMAIL_KEY = 'bns_last_local_part'
const remember = ref(localStorage.getItem(REMEMBER_KEY) !== '0')

const route = useRoute()
const router = useRouter()
const emailInput = ref<HTMLInputElement | null>(null)
const codeBoxes = ref<(HTMLInputElement | null)[]>([])

function setBoxRef(el: unknown, i: number) {
  codeBoxes.value[i] = (el as HTMLInputElement) || null
}

/** 重发倒计时只跟随服务端给的秒数，不自己编数字。 */
const resendIn = ref(0)
let resendTimer: number | undefined

function startCountdown(seconds: number) {
  resendIn.value = Math.max(0, Math.ceil(seconds))
  if (resendTimer) window.clearInterval(resendTimer)
  if (resendIn.value <= 0) return
  resendTimer = window.setInterval(() => {
    resendIn.value = Math.max(0, resendIn.value - 1)
    if (resendIn.value === 0 && resendTimer) {
      window.clearInterval(resendTimer)
      resendTimer = undefined
    }
  }, 1000)
}

onUnmounted(() => {
  if (resendTimer) window.clearInterval(resendTimer)
  window.removeEventListener('keydown', onGlobalKey)
})
onMounted(() => {
  // 记住上次登录的姓名拼音：下次只需输 6 位验证码
  const last = localStorage.getItem(LAST_EMAIL_KEY)
  if (last) localPart.value = last
  // 校内邮箱域名来自本年级实例配置
  auth.loadConfig().then(() => { emailDomain.value = auth.emailDomain })
  emailInput.value?.focus()
  window.addEventListener('keydown', onGlobalKey)
})

function onRememberChange() {
  localStorage.setItem(REMEMBER_KEY, remember.value ? '1' : '0')
}

const contactEmail = 'kellswang@hotmail.com'
const mailto = `mailto:${contactEmail}?subject=${encodeURIComponent('关于英语教研平台的咨询')}`

function shake() {
  shaking.value = true
  window.setTimeout(() => { shaking.value = false }, 380)
}

/** 只保留小写字母、数字与 . _ -，并把粘贴进来的完整邮箱削成前缀。 */
function cleanLocal(raw: string) {
  let value = raw.trim().toLowerCase()
  if (value.includes('@')) value = value.split('@')[0]
  return value.replace(/[^a-z0-9._-]/g, '')
}

/**
 * 中文拼音输入法：组字过程中（composition）绝不能改写 input.value。
 * 之前每个 input 事件都强制回写清洗后的值，会打断 IME 组字，
 * 已上屏的拼音被重新插入 → 出现「wangfeifanwangfeifan」这类重复。
 * 现在组字期间完全不干预，等 compositionend 再统一清洗一次。
 */
let emailComposing = false

function onEmailInput(event: Event) {
  if (emailComposing || (event as InputEvent).isComposing) return
  applyEmailValue(event.target as HTMLInputElement)
}

function onEmailCompositionStart() {
  emailComposing = true
}

function onEmailCompositionEnd(event: CompositionEvent) {
  emailComposing = false
  applyEmailValue(event.target as HTMLInputElement)
}

function applyEmailValue(el: HTMLInputElement) {
  const cleaned = cleanLocal(el.value)
  if (cleaned !== el.value) {
    // 只在确实需要过滤时回写，并把光标放到末尾（拼音输入都是顺序追加）
    el.value = cleaned
    el.setSelectionRange(cleaned.length, cleaned.length)
  }
  if (cleaned === localPart.value) return
  localPart.value = cleaned
  emailError.value = ''
  // 邮箱一改，之前收到的验证码就不再对应它，直接收起验证码区
  if (stage.value === 'code') {
    stage.value = 'email'
    clearCode()
    codeHint.value = ''
    devCode.value = ''
    resendIn.value = 0
    if (resendTimer) { window.clearInterval(resendTimer); resendTimer = undefined }
  }
}

function clearCode() {
  codeDigits.value = ['', '', '', '', '', '']
  codeError.value = ''
}

/** 6 格验证码：只收数字，多字/粘贴自动依次分格，填满第 6 位自动提交。 */
let boxComposing = false

function onBoxCompositionStart() {
  boxComposing = true
}

function onBoxCompositionEnd(i: number, event: CompositionEvent) {
  boxComposing = false
  onBoxInput(i, event as unknown as Event)
}

function onBoxInput(i: number, event: Event) {
  if (boxComposing || (event as InputEvent).isComposing) return
  const el = event.target as HTMLInputElement
  const digits = el.value.replace(/\D/g, '').slice(0, 6 - i)
  el.value = ''
  for (let k = 0; k < digits.length; k++) codeDigits.value[i + k] = digits[k]
  codeError.value = ''
  nextTick(() => {
    codeBoxes.value.forEach((box, idx) => { if (box) box.value = codeDigits.value[idx] })
  })
  const next = Math.min(5, i + digits.length)
  codeBoxes.value[next]?.focus()
  if (code.value.length === 6) void submitCode()
}

function onBoxKeyDown(i: number, event: KeyboardEvent) {
  if (event.key === 'Backspace' && !codeDigits.value[i] && i > 0) {
    codeDigits.value[i - 1] = ''
    nextTick(() => { const b = codeBoxes.value[i - 1]; if (b) b.value = '' })
    codeBoxes.value[i - 1]?.focus()
  }
}

async function sendCode() {
  if (sending.value || resendIn.value > 0) return
  emailError.value = ''
  codeError.value = ''
  const local = cleanLocal(localPart.value)
  if (!local) {
    emailError.value = '请输入姓名拼音全拼'
    emailInput.value?.focus()
    shake()
    return
  }
  localPart.value = local
  sending.value = true
  try {
    const res = await auth.requestCode(fullEmail.value)
    stage.value = 'code'
    codeHint.value = `验证码已发送至 ${res.email}，5 分钟内有效`
    startCountdown(res.resend_after || 60)
    devCode.value = res.dev_code || ''
    await nextTick()
    codeBoxes.value[0]?.focus()
  } catch (e: any) {
    const code = e?.detail?.code
    if (code === 'not_invited' || code === 'invite_disabled' || e?.status === 403) {
      // 非邀请用户：不发码、不建号，只给权限提示弹窗
      notInvited.value = true
    } else if (e?.status === 429) {
      startCountdown(e.retryAfter || 60)
      emailError.value = e?.message || '请求过于频繁，请稍后再试'
    } else {
      emailError.value = e?.message || '验证码发送失败，请稍后重试'
    }
    if (!notInvited.value) shake()
  } finally {
    sending.value = false
  }
}

async function submitCode() {
  if (verifying.value) return
  codeError.value = ''
  if (code.value.length !== 6) {
    codeError.value = '请输入 6 位数字验证码'
    codeBoxes.value[Math.min(5, code.value.length)]?.focus()
    shake()
    return
  }
  verifying.value = true
  try {
    await auth.verifyCode(fullEmail.value, code.value, remember.value)
    localStorage.setItem(LAST_EMAIL_KEY, localPart.value)
    const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
    await router.replace(target)
  } catch (e: any) {
    if (e?.status === 429) {
      startCountdown(e.retryAfter || 0)
      codeError.value = e?.message || '尝试次数过多，请重新获取验证码'
    } else {
      codeError.value = e?.message || '验证码不正确'
    }
    clearCode()
    shake()
    await nextTick()
    codeBoxes.value.forEach((box) => { if (box) box.value = '' })
    codeBoxes.value[0]?.focus()
  } finally {
    verifying.value = false
  }
}

function closeNotInvited() {
  notInvited.value = false
  nextTick(() => emailInput.value?.focus())
}

function onGlobalKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && notInvited.value) closeNotInvited()
}

function onSubmit() {
  return stage.value === 'email' ? sendCode() : submitCode()
}
</script>

<template>
  <div class="gate">
    <LoginVisual />
    <div class="gate-side">
      <form class="gate-form" :class="{ 'gate-shake': shaking }" @submit.prevent="onSubmit">
        <p class="gate-eyebrow">四年级英语教研组</p>
        <h1>{{ auth.appName || '英语教研平台' }}</h1>
        <p class="gate-lede">图片创作平台，用校内邮箱接收验证码后进入。</p>

        <div class="gate-field">
          <label class="field-label" for="teacher-email">校内邮箱</label>
          <div class="gate-email">
            <input
              id="teacher-email"
              ref="emailInput"
              :value="localPart"
              class="gate-email-input"
              type="text"
              inputmode="email"
              autocomplete="username"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              lang="en"
              placeholder="请输入姓名全拼"
              @input="onEmailInput"
              @compositionstart="onEmailCompositionStart"
              @compositionend="onEmailCompositionEnd"
            />
            <span class="gate-email-suffix">@{{ EMAIL_DOMAIN }}</span>
          </div>
          <p class="gate-hint">请输入姓名拼音全拼</p>
          <p v-if="emailError" class="gate-error" role="alert">{{ emailError }}</p>
        </div>

        <div v-if="stage === 'code'" class="gate-code">
          <div class="gate-field gate-field-tight">
            <label class="field-label" for="code-box-0">验证码</label>
            <div class="gate-code-row" autocomplete="one-time-code">
              <input
                v-for="i in 6"
                :id="i === 1 ? 'code-box-0' : undefined"
                :key="i"
                :ref="(el) => setBoxRef(el, i - 1)"
                class="gate-code-box"
                :value="codeDigits[i - 1]"
                type="text"
                inputmode="numeric"
                maxlength="2"
                :aria-label="`验证码第 ${i} 位`"
                @input="onBoxInput(i - 1, $event)"
                @compositionstart="onBoxCompositionStart"
                @compositionend="onBoxCompositionEnd(i - 1, $event)"
                @keydown="onBoxKeyDown(i - 1, $event)"
              />
            </div>
            <p v-if="codeHint && !codeError" class="gate-hint">{{ codeHint }}</p>
            <p v-if="devCode" class="gate-hint gate-dev">演练环境验证码：{{ devCode }}</p>
            <p v-if="codeError" class="gate-error" role="alert">{{ codeError }}</p>
          </div>

          <label class="gate-remember">
            <input type="checkbox" :checked="remember" @change="onRememberChange" />
            <span>记住这台设备，30 天内免验证码</span>
          </label>

          <button class="gate-submit" type="submit" :disabled="verifying">
            {{ verifying ? '正在验证…' : '登录' }}
          </button>
          <button class="gate-resend" type="button" :disabled="resendIn > 0 || sending" @click="sendCode">
            {{ resendIn > 0 ? `重新发送（${resendIn} 秒）` : '重新发送' }}
          </button>
        </div>

        <button v-else class="gate-submit" type="submit" :disabled="sending">
          {{ sending ? '正在发送…' : '发送验证码' }}
        </button>
      </form>

      <footer class="gate-info">
        <p class="gate-info-line">
          <span>校内系统，不对公众开放</span>
          <i aria-hidden="true" />
          <span>运行于香港节点</span>
        </p>
        <a class="gate-mail" :href="mailto" rel="nofollow">
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="1.6" y="3.4" width="12.8" height="9.2" stroke="currentColor" stroke-width="1.2" />
            <path d="M2 4l6 4.4L14 4" stroke="currentColor" stroke-width="1.2" />
          </svg>
          邮件联系
        </a>
      </footer>
    </div>

    <div v-if="notInvited" class="modal-scrim" role="dialog" aria-modal="true"
         aria-labelledby="not-invited-title" @click.self="closeNotInvited">
      <div class="modal-card">
        <div class="modal-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none">
            <rect x="4.4" y="8.6" width="11.2" height="7.6" rx="1.8"
                  stroke="currentColor" stroke-width="1.3" />
            <path d="M7.2 8.6V6.6a2.8 2.8 0 015.6 0v2" stroke="currentColor"
                  stroke-width="1.3" stroke-linecap="round" />
            <circle cx="10" cy="12.4" r="1.15" fill="currentColor" />
          </svg>
        </div>
        <h2 id="not-invited-title">这个邮箱还没有开通</h2>
        <p class="modal-lede">
          <code>{{ fullEmail }}</code> 不在英语教研组的邀请名单内。
        </p>
        <p class="modal-note">
          需要开通请联系 <b>王飞凡</b>（企业微信）<br />
          说明姓名与校内邮箱即可。
        </p>
        <button class="modal-btn" type="button" @click="closeNotInvited">重新输入邮箱</button>
        <a class="modal-link" :href="mailto" rel="nofollow">或发送邮件申请</a>
      </div>
    </div>
  </div>
</template>
