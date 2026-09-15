<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArchiveRestore, CircleAlert, Clock, LoaderCircle, RotateCcw } from '@lucide/vue'
import { useCheckpointStore } from '../../stores/checkpoint'
import type { RunCheckpointRevertCounts } from '../../types'

/**
 * PLAN-0328 M3 (spec/ui-ux §4.1): Run snapshot status marker rendered beside a message/run
 * in the chat timeline. Four visual states — rollbackable / no snapshot / not rollbackable
 * (with reason) / already reverted (time + summary). The marker itself is non-interactive;
 * only the revert entry inside the rollbackable state accepts clicks.
 */
const props = defineProps<{
  runId: string
  sessionId?: string
}>()

const emit = defineEmits<{
  revert: [runId: string]
}>()

const { t } = useI18n()
const checkpointStore = useCheckpointStore()

const record = computed(() => {
  const current = checkpointStore.get(props.runId)
  // An error-only record (no authoritative projection yet) has no state evidence: stay silent
  // instead of claiming "不可回滚".
  return current?.loaded ? current : undefined
})

type MarkerKind = 'rollbackable' | 'reverted' | 'unavailable' | 'none'

const kind = computed<MarkerKind>(() => {
  const current = record.value
  if (!current) return 'none'
  const revertState = current.revert?.state ?? 'none'
  if (revertState === 'rolled_back' || revertState === 'partial' || revertState === 'failed') {
    return 'reverted'
  }
  if (current.state === 'sealed') return 'rollbackable'
  if (current.state === 'degraded' || current.state === 'expired' || current.state === 'unknown') {
    return 'unavailable'
  }
  return 'none'
})

const isUnsealed = computed(() => record.value?.state === 'base' || record.value?.state === 'unsealed')

/** Frozen reason vocabulary of degraded rows / extended reasons, falling back to the raw code. */
const unrollableLabel = computed(() => {
  const current = record.value
  if (!current) return ''
  const reason = current.unrollableReason
  const keys: Record<string, string> = {
    LEASE_HELD: 'chat.checkpointReasonLeaseHeld',
    UNAVAILABLE: 'chat.checkpointReasonUnavailable',
    GIT_UNAVAILABLE: 'chat.checkpointReasonGitUnavailable',
    GIT_TOO_OLD: 'chat.checkpointReasonGitTooOld',
    GIT_FAILED: 'chat.checkpointReasonGitFailed',
    WORKSPACE_UNKNOWN: 'chat.checkpointReasonWorkspaceUnknown',
    EXPIRED: 'chat.checkpointReasonExpired',
    MISSING: 'chat.checkpointReasonMissing',
  }
  if (current.state === 'expired') return t('chat.checkpointReasonExpired')
  if (current.state === 'unknown') return t('chat.checkpointReasonUnknownState')
  const key = reason ? keys[reason] : undefined
  return key ? t(key) : (reason ?? t('chat.checkpointReasonUnavailable'))
})

const revertedAt = computed(() => {
  const at = record.value?.revert?.at
  if (!at) return ''
  const parsed = new Date(at)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString()
})

const revertSummary = computed(() => {
  const counts = record.value?.revert?.counts
  if (!counts) return [] as string[]
  const labels: Array<{ key: keyof RunCheckpointRevertCounts; labelKey: string }> = [
    { key: 'restored', labelKey: 'chat.checkpointCountRestored' },
    { key: 'deleted', labelKey: 'chat.checkpointCountDeleted' },
    { key: 'skippedConflict', labelKey: 'chat.checkpointCountSkipped' },
    { key: 'failed', labelKey: 'chat.checkpointCountFailed' },
  ]
  const parts: string[] = []
  for (const { key, labelKey } of labels) {
    const value = counts[key]
    if (value !== undefined) parts.push(`${t(labelKey)} ${value}`)
  }
  return parts
})

const isPartialRevert = computed(() => {
  const revert = record.value?.revert
  if (!revert) return false
  return revert.state === 'partial' || revert.state === 'failed'
    || (revert.counts?.skippedConflict ?? 0) > 0
    || (revert.counts?.failed ?? 0) > 0
})

const changedFilesTitle = computed(() => {
  const files = record.value?.changedFiles ?? []
  return files.map((file) => `${file.status} ${file.path}`.trim()).join('\n')
})

function loadCheckpoint() {
  if (!props.runId) return
  void checkpointStore.fetchCheckpoint(props.runId, { sessionId: props.sessionId })
}

onMounted(loadCheckpoint)
watch(() => props.runId, loadCheckpoint)
</script>

<template>
  <div
    v-if="record"
    data-testid="run-checkpoint-marker"
    :data-checkpoint-kind="kind"
    class="mt-1.5 flex flex-wrap items-center gap-2 text-xs"
  >
    <template v-if="kind === 'rollbackable'">
      <span
        data-testid="run-checkpoint-summary"
        class="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-muted-foreground"
        :title="changedFilesTitle || undefined"
      >
        <RotateCcw class="size-3.5 shrink-0" aria-hidden="true" />
        {{ t('chat.checkpointMarkerChangedPrefix') }} {{ record.changedCount }} {{ t('chat.checkpointMarkerChangedUnit') }}
        · {{ t('chat.checkpointMarkerRollbackable') }}
      </span>
      <button
        type="button"
        data-testid="run-checkpoint-revert-entry"
        class="inline-flex min-h-7 items-center rounded-md border px-2 py-1 font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="record.loading"
        @click="emit('revert', record.runId)"
      >
        <LoaderCircle v-if="record.loading" class="mr-1 size-3.5 animate-spin" aria-hidden="true" />
        {{ t('chat.checkpointMarkerRevertEntry') }}
      </button>
    </template>

    <template v-else-if="kind === 'reverted'">
      <span
        data-testid="run-checkpoint-reverted"
        class="inline-flex flex-wrap items-center gap-1.5 rounded-md border px-2 py-1"
        :class="isPartialRevert
          ? 'border-amber-500/40 bg-amber-500/10 text-foreground'
          : 'bg-muted/40 text-muted-foreground'"
      >
        <ArchiveRestore class="size-3.5 shrink-0" aria-hidden="true" />
        {{ t('chat.checkpointMarkerReverted') }}
        <template v-if="revertedAt">· {{ revertedAt }}</template>
        <span
          v-for="part in revertSummary"
          :key="part"
          data-testid="run-checkpoint-revert-summary"
          class="text-muted-foreground"
        >· {{ part }}</span>
      </span>
    </template>

    <template v-else-if="kind === 'unavailable'">
      <span
        data-testid="run-checkpoint-unavailable"
        class="inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-foreground"
      >
        <CircleAlert class="size-3.5 shrink-0" aria-hidden="true" />
        {{ t('chat.checkpointMarkerUnrollable') }}
        <span class="text-muted-foreground">（{{ unrollableLabel }}）</span>
      </span>
    </template>

    <template v-else>
      <span
        data-testid="run-checkpoint-none"
        class="inline-flex items-center gap-1.5 rounded-md border bg-muted/20 px-2 py-1 text-muted-foreground"
      >
        <Clock class="size-3.5 shrink-0" aria-hidden="true" />
        {{ t('chat.checkpointMarkerNoSnapshot') }}
        <template v-if="isUnsealed">· {{ t('chat.checkpointMarkerUnsealed') }}</template>
      </span>
    </template>
  </div>
</template>
