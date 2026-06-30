<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCall } from '../../types'

const props = defineProps<{
  toolCall: ToolCall
}>()

const emit = defineEmits<{
  approve: [id: string]
  reject: [id: string]
}>()

const { t } = useI18n()
const expanded = ref(false)

const statusColors: Record<string, string> = {
  pending: 'text-yellow-500',
  running: 'text-blue-500',
  completed: 'text-green-500',
  failed: 'text-red-500',
  approved: 'text-green-500',
  rejected: 'text-red-500',
}

const statusIcons: Record<string, string> = {
  pending: 'i-lucide-clock',
  running: 'i-lucide-loader-circle',
  completed: 'i-lucide-check-circle',
  failed: 'i-lucide-x-circle',
  approved: 'i-lucide-check-circle',
  rejected: 'i-lucide-x-circle',
}

const duration = computed(() => {
  if (!props.toolCall.startedAt || !props.toolCall.completedAt) return null
  const ms = new Date(props.toolCall.completedAt).getTime() - new Date(props.toolCall.startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
})
</script>

<template>
  <div class="my-2 rounded-lg border bg-card overflow-hidden">
    <button
      class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent/50 transition-colors"
      @click="expanded = !expanded"
    >
      <span :class="[statusIcons[toolCall.status] || 'i-lucide-bot', 'size-4 shrink-0', statusColors[toolCall.status] || 'text-muted-foreground']" />
      <span class="font-medium flex-1 text-left truncate">{{ toolCall.name }}</span>
      <span v-if="duration" class="text-xs text-muted-foreground tabular-nums">{{ duration }}</span>
      <span
        class="text-xs"
        :class="statusColors[toolCall.status] || 'text-muted-foreground'"
      >
        {{ t(`chat.toolStatus.${toolCall.status}`) }}
      </span>
      <span
        class="i-lucide-chevron-down size-4 text-muted-foreground transition-transform"
        :class="expanded ? 'rotate-180' : ''"
      />
    </button>
    <div v-if="expanded" class="px-3 pb-3 space-y-2 border-t pt-2 text-xs">
      <div class="text-muted-foreground font-mono">
        <div class="font-medium text-foreground mb-1">Arguments</div>
        <pre class="whitespace-pre-wrap break-all bg-muted/30 p-2 rounded">{{ typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments, null, 2) }}</pre>
      </div>
      <div v-if="toolCall.result" class="font-mono">
        <div class="font-medium text-foreground mb-1">Result</div>
        <pre class="whitespace-pre-wrap break-all bg-muted/30 p-2 rounded">{{ typeof toolCall.result === 'string' ? toolCall.result.substring(0, 2000) : JSON.stringify(toolCall.result, null, 2) }}</pre>
        <p v-if="toolCall.result.length > 2000" class="text-muted-foreground mt-1">Output truncated ({{ toolCall.result.length }} chars total)</p>
      </div>
      <div v-if="toolCall.error" class="font-mono">
        <div class="font-medium text-destructive mb-1">Error</div>
        <pre class="whitespace-pre-wrap break-all bg-destructive/10 p-2 rounded text-destructive">{{ toolCall.error }}</pre>
      </div>
      <div v-if="toolCall.status === 'pending'" class="flex gap-2 pt-1">
        <button
          class="px-3 py-1 text-xs rounded bg-primary text-primary-foreground hover:opacity-90"
          @click="emit('approve', toolCall.id)"
        >
          {{ t('chat.approve') }}
        </button>
        <button
          class="px-3 py-1 text-xs rounded border text-muted-foreground hover:bg-accent"
          @click="emit('reject', toolCall.id)"
        >
          {{ t('chat.reject') }}
        </button>
      </div>
    </div>
  </div>
</template>
