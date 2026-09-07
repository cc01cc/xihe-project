<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ToolCall } from '../../types'
import {
  LoaderCircle,
  CheckCircle,
  XCircle,
  Clock,
  Bot,
  ChevronDown,
} from '@lucide/vue'

const props = defineProps<{
  toolCall: ToolCall
}>()

const emit = defineEmits<{
  approve: [id: string]
  reject: [id: string]
}>()

const { t } = useI18n()
const expanded = ref(false)

const statusIcons: Record<string, typeof LoaderCircle> = {
  pending: Clock,
  running: LoaderCircle,
  completed: CheckCircle,
  failed: XCircle,
  approved: CheckCircle,
  rejected: XCircle,
}

const statusColors: Record<string, string> = {
  pending: 'text-yellow-500',
  running: 'text-blue-500',
  completed: 'text-green-500',
  failed: 'text-red-500',
  approved: 'text-green-500',
  rejected: 'text-red-500',
}

const duration = computed(() => {
  if (!props.toolCall.startedAt || !props.toolCall.completedAt) return null
  const ms = new Date(props.toolCall.completedAt).getTime() - new Date(props.toolCall.startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
})
</script>

<template>
  <div class="my-2 overflow-hidden rounded-lg border bg-card">
    <button
      class="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent/50"
      @click="expanded = !expanded"
    >
       <component
         :is="statusIcons[toolCall.status] || Bot"
         class="size-4 shrink-0"
         :class="statusColors[toolCall.status] || 'text-muted-foreground'"
         aria-hidden="true"
       />
      <span class="font-medium flex-1 text-left truncate">{{ toolCall.name }}</span>
      <span v-if="duration" class="text-xs text-muted-foreground tabular-nums">{{ duration }}</span>
      <span
        class="text-xs"
        :class="statusColors[toolCall.status] || 'text-muted-foreground'"
      >
        {{ t(`chat.toolStatus.${toolCall.status}`) }}
      </span>
       <ChevronDown
         class="size-4 text-muted-foreground transition-transform"
         :class="expanded ? 'rotate-180' : ''"
         aria-hidden="true"
       />
    </button>

    <div v-if="expanded" class="space-y-2 border-t px-3 pb-3 pt-2 text-xs">
      <div class="font-mono text-muted-foreground">
        <div class="mb-1 font-medium text-foreground">Arguments</div>
        <pre class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all">{{ typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments, null, 2) }}</pre>
      </div>
      <div v-if="toolCall.result" class="font-mono">
        <div class="mb-1 font-medium text-foreground">Result</div>
        <pre class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all">{{ typeof toolCall.result === 'string' ? toolCall.result.substring(0, 2000) : JSON.stringify(toolCall.result, null, 2) }}</pre>
        <p v-if="toolCall.result.length > 2000" class="mt-1 text-muted-foreground">Output truncated ({{ toolCall.result.length }} chars total)</p>
      </div>
      <div v-if="toolCall.error" class="font-mono">
        <div class="mb-1 font-medium text-destructive">Error</div>
        <pre class="rounded bg-destructive/10 p-2 whitespace-pre-wrap break-all text-destructive">{{ toolCall.error }}</pre>
      </div>
      <div v-if="toolCall.status === 'pending'" class="flex gap-2 pt-1">
        <button
          class="rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90"
          @click="emit('approve', toolCall.id)"
        >
          {{ t('chat.approve') }}
        </button>
        <button
          class="rounded border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
          @click="emit('reject', toolCall.id)"
        >
          {{ t('chat.reject') }}
        </button>
      </div>
    </div>
  </div>
</template>
