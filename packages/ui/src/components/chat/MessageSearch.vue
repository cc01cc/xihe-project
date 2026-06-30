<script setup lang="ts">
import { ref } from 'vue'

const model = defineModel<string>('modelValue', { required: true })
const emit = defineEmits<{ close: [] }>()
const inputRef = ref<HTMLInputElement | null>(null)
void inputRef
</script>

<template>
  <div class="flex items-center gap-1 bg-background border rounded-lg shadow-lg px-3 py-1.5">
    <input
      ref="inputRef"
      v-model="model"
      type="text"
      placeholder="搜索消息…"
      class="w-48 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
      autofocus
    />
    <button
      class="text-muted-foreground hover:text-foreground transition-colors"
      aria-label="Close search"
      @click="emit('close')"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  </div>
</template>
