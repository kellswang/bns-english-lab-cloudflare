<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

/** 左侧逐帧动画占位：视频缺失/解码失败时保持静帧封面，登录流程完全不受影响。 */
const ready = ref(false)
const failed = ref(false)
const allowVideo = ref(false)
let mq: MediaQueryList | null = null

// 绑定而非静态字符串，避免构建器把 /media 下的媒体当模块解析
// 封面优先用视频首帧（加载瞬间不跳色），首帧缺失时回退到设计稿 SVG
const posterSrc = ref('/media/login-poster.jpg')
const webmSrc = '/media/login-animation.webm'
const mp4Src = '/media/login-animation.mp4'
function onPosterError() { posterSrc.value = '/media/login-poster.svg' }

function onChange(e: MediaQueryListEvent | MediaQueryList) {
  allowVideo.value = !e.matches
  if (e.matches) { ready.value = false; failed.value = false }
}

onMounted(() => {
  mq = window.matchMedia?.('(prefers-reduced-motion: reduce)') || null
  if (!mq) { allowVideo.value = true; return }
  onChange(mq)
  mq.addEventListener?.('change', onChange as (e: MediaQueryListEvent) => void)
})
onUnmounted(() => {
  mq?.removeEventListener?.('change', onChange as (e: MediaQueryListEvent) => void)
})
</script>

<template>
  <div class="gate-visual">
    <img class="gate-poster" :src="posterSrc" alt="" aria-hidden="true" @error="onPosterError" />
    <video
      v-if="allowVideo && !failed"
      class="gate-video"
      :class="{ ready }"
      :poster="posterSrc"
      autoplay muted loop playsinline preload="metadata"
      aria-hidden="true" tabindex="-1"
      @playing="ready = true"
      @error="failed = true"
    >
      <source :src="webmSrc" type="video/webm" />
      <source :src="mp4Src" type="video/mp4" />
    </video>
  </div>
</template>
