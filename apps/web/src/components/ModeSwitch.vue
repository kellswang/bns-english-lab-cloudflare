<script setup lang="ts">
defineProps<{ modelValue: 'chat' | 'image' }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: 'chat' | 'image'): void }>()
</script>

<template>
  <div class="mode-switch" role="tablist" aria-label="工作模式">
    <button type="button" role="tab" :aria-selected="modelValue === 'chat'"
            :class="{ active: modelValue === 'chat' }" @click="emit('update:modelValue', 'chat')">
      AI 对话
    </button>
    <button type="button" role="tab" :aria-selected="modelValue === 'image'"
            :class="{ active: modelValue === 'image' }" @click="emit('update:modelValue', 'image')">
      图片生成
    </button>
    <span class="mode-switch-thumb" :style="{ transform: modelValue === 'image' ? 'translateX(100%)' : 'none' }" />
  </div>
</template>
