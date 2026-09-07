<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import BaseModal from '../shared/BaseModal.vue'
import type { ApprovalRequest } from '../../types'
import { Bot } from '@lucide/vue'

defineProps<{
  approval: ApprovalRequest | null
  show: boolean
  busy?: boolean
  error?: string | null
}>()

const emit = defineEmits<{
  approve: [requestId: string]
  reject: [requestId: string]
  close: []
}>()

const { t } = useI18n()
</script>

<template>
  <BaseModal :show="show" :title="t('chat.approvalRequired')" @close="emit('close')">
    <p class="text-sm text-muted-foreground mb-3">
      The agent wants to execute the following tool:
    </p>

    <div v-if="approval" class="space-y-2 mb-4">
      <div class="flex items-center gap-2 text-sm">
        <Bot class="size-4 text-muted-foreground" aria-hidden="true" />
        <span class="font-medium">{{ approval.tool }}</span>
      </div>
      <p class="text-sm">{{ approval.action }}</p>
      <pre class="text-xs font-mono bg-muted/50 p-3 rounded whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{{ approval.details }}</pre>
    </div>

    <p v-if="error" data-testid="approval-error" class="mb-3 text-sm text-destructive">{{ error }}</p>

    <div class="flex justify-end gap-2 pt-2 border-t">
      <button
        data-testid="approval-reject"
        class="px-3 py-1.5 text-sm rounded border hover:bg-accent transition-colors"
        :disabled="busy || !approval"
        @click="approval && emit('reject', approval.requestId)"
      >
        {{ t('chat.reject') }}
      </button>
      <button
        data-testid="approval-approve"
        class="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90 transition-colors"
        :disabled="busy || !approval"
        @click="approval && emit('approve', approval.requestId)"
      >
        {{ busy ? t('common.saving') : t('chat.approve') }}
      </button>
    </div>
  </BaseModal>
</template>
