<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { CircleAlert } from '@lucide/vue'
import { usePolicyStore } from '../../stores/policy'
import { logger } from '../../lib/logger'
import type { SessionPolicyMode } from '../../types'

const props = defineProps<{
  sessionId: string
}>()

const { t } = useI18n()
const policyStore = usePolicyStore()

const modeLabelKeys: Record<SessionPolicyMode, string> = {
  default: 'chat.approvalModeDefault',
  'accept-edits': 'chat.approvalModeAcceptEdits',
  bypass: 'chat.approvalModeBypass',
  plan: 'chat.approvalModePlan',
  managed: 'chat.approvalModeManaged',
}
const policyModes = Object.keys(modeLabelKeys) as SessionPolicyMode[]

function isPolicyMode(value: string): value is SessionPolicyMode {
  return policyModes.includes(value as SessionPolicyMode)
}

const state = computed(() => policyStore.getState(props.sessionId))
const mode = computed(() => state.value?.mode ?? null)
const modeLabel = computed(() => mode.value ? t(modeLabelKeys[mode.value]) : t('chat.approvalModeUnavailable'))
const busy = computed(() => Boolean(state.value?.loading || state.value?.changing))

watch(() => props.sessionId, (sessionId) => {
  if (sessionId) void policyStore.load(sessionId)
}, { immediate: true })

async function changeMode(nextMode: SessionPolicyMode) {
  const sessionId = props.sessionId
  if (!sessionId || busy.value) return
  try {
    const result = await policyStore.change(sessionId, nextMode)
    if (props.sessionId === sessionId) {
      toast.success(`${t('chat.approvalModeChanged')}: ${t(modeLabelKeys[result.mode])}`)
    }
  } catch (cause) {
    logger.warn('Session policy mode change failed', cause)
  }
}

function handleModeChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (isPolicyMode(value)) void changeMode(value)
}
</script>

<template>
  <div class="shrink-0 border-b bg-background/80 px-3 py-2">
    <div class="flex items-center justify-between gap-2">
      <span data-testid="session-policy-mode-badge" class="inline-flex min-w-0 items-center gap-1 rounded-md border px-2 py-1 text-xs text-muted-foreground">
        <span>{{ t('chat.approvalModeLabel') }}</span>
        <span class="truncate font-medium text-foreground">{{ modeLabel }}</span>
      </span>
      <label class="sr-only" :for="`session-policy-mode-${sessionId}`">{{ t('chat.approvalModeLabel') }}</label>
      <select
        :id="`session-policy-mode-${sessionId}`"
        data-testid="session-policy-mode"
        class="max-w-36 rounded-md border bg-background px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        :value="mode ?? ''"
        :disabled="!mode || busy"
        @change="handleModeChange"
      >
        <option value="" disabled>{{ t('chat.approvalModeUnavailable') }}</option>
        <option v-for="policyMode in policyModes" :key="policyMode" :value="policyMode">{{ t(modeLabelKeys[policyMode]) }}</option>
      </select>
    </div>
  </div>

  <div
    v-if="mode === 'bypass'"
    data-testid="session-policy-bypass-banner"
    class="flex items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    role="alert"
  >
    <div class="flex min-w-0 items-center gap-2">
      <CircleAlert class="size-4 shrink-0" aria-hidden="true" />
      <span>{{ t('chat.approvalBypassWarning') }}</span>
    </div>
    <button
      type="button"
      data-testid="session-policy-bypass-close"
      class="shrink-0 rounded-md border border-amber-500/40 px-2 py-1 text-xs font-medium transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      :disabled="busy"
      @click="changeMode('default')"
    >
      {{ t('chat.approvalBypassClose') }}
    </button>
  </div>
  <p v-if="state?.error" data-testid="session-policy-mode-error" class="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{{ state.error }}</p>
</template>
