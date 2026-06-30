<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import BaseModal from '../shared/BaseModal.vue'
import type { ToolCall } from '../../types'

defineProps<{
  toolCall: ToolCall | null
  show: boolean
}>()

const emit = defineEmits<{
  approve: [id: string]
  reject: [id: string]
  close: []
}>()

const { t } = useI18n()
</script>

<template>
  <BaseModal :show="show" @close="emit('close')">
    <h3 class="text-base font-semibold mb-2">Approve Tool Call</h3>
    <p class="text-sm text-muted-foreground mb-3">
      The agent wants to execute the following tool:
    </p>

    <div v-if="toolCall" class="space-y-2 mb-4">
      <div class="flex items-center gap-2 text-sm">
        <span class="i-lucide-bot size-4 text-muted-foreground" />
        <span class="font-medium">{{ toolCall.name }}</span>
      </div>
      <pre class="text-xs font-mono bg-muted/50 p-3 rounded whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{{ typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments, null, 2) }}</pre>
    </div>

    <div class="flex justify-end gap-2 pt-2 border-t">
      <button
        class="px-3 py-1.5 text-sm rounded border hover:bg-accent transition-colors"
        @click="emit('reject', toolCall?.id || ''); emit('close')"
      >
        {{ t('chat.reject') }}
      </button>
      <button
        class="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 transition-colors"
        @click="emit('approve', toolCall?.id || ''); emit('close')"
      >
        {{ t('chat.approve') }}
      </button>
    </div>
  </BaseModal>
</template>
