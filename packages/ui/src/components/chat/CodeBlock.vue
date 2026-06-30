<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import DOMPurify from 'dompurify'
import { logger } from '@/lib/logger'

const props = defineProps<{
  code: string
  lang: string
  highlightedHtml?: string
}>()

const { t } = useI18n()
const copied = ref(false)

function handleCopy() {
  navigator.clipboard.writeText(props.code)
    .then(() => {
      copied.value = true
      setTimeout(() => { copied.value = false }, 2000)
    })
    .catch((error) => {
      logger.warn('Failed to copy code', error)
    })
}

function handleApply() {
  window.dispatchEvent(new CustomEvent('xihe:apply-code', { detail: { code: props.code, lang: props.lang } }))
}

const displayHtml = computed(() => DOMPurify.sanitize(props.highlightedHtml || escapeHtml(props.code)))

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
</script>

<template>
  <div class="group relative my-2 rounded-lg overflow-hidden border bg-muted/50">
    <div class="flex items-center justify-between px-4 py-1.5 bg-muted/80 border-b">
      <span class="text-xs font-mono text-muted-foreground">{{ lang }}</span>
      <div class="flex gap-1">
        <button
          class="px-2 py-1 text-xs rounded hover:bg-background transition-colors text-muted-foreground hover:text-foreground"
          @click="handleApply"
        >
          {{ t('chat.apply') }}
        </button>
        <button
          class="px-2 py-1 text-xs rounded transition-colors"
          :class="copied ? 'bg-green-500/10 text-green-600' : 'hover:bg-background text-muted-foreground hover:text-foreground'"
          @click="handleCopy"
        >
          {{ copied ? t('chat.copied') : t('chat.copy') }}
        </button>
      </div>
    </div>
    <div class="overflow-x-auto">
      <pre class="p-4 text-sm leading-relaxed"><code v-html="displayHtml" /></pre>
    </div>
  </div>
</template>
