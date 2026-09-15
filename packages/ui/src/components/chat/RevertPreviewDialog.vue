<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, ChevronUp, CircleAlert, LoaderCircle } from '@lucide/vue'
import { ApiError, api } from '../../composables/api'
import { logger } from '../../lib/logger'
import type { RevertAcknowledge, RevertPreview, RevertPreviewEntry } from '../../types'
import CheckpointDialogShell from './CheckpointDialogShell.vue'

/**
 * PLAN-0328 M3 (spec/ui-ux §4.2): required dry-run preview of a Run revert. Shows the plan
 * (restore/delete/skip-conflicts/noop + paths), defaults focus to cancel (U2), and gates the
 * submit on explicit acknowledgements: every conflicting path and a changed/unknown workspace
 * head fingerprint from the preview must be acknowledged. No conflict entry can ever be
 * force-restored from here (V1 decision).
 */
const props = withDefaults(defineProps<{
  show: boolean
  runId: string
  busy?: boolean
  error?: string | null
}>(), {
  busy: false,
  error: null,
})

const emit = defineEmits<{
  confirm: [payload: RevertAcknowledge]
  close: []
}>()

const { t } = useI18n()

const loading = ref(false)
const loadError = ref<string | null>(null)
const preview = ref<RevertPreview | null>(null)
const conflictAck = ref(false)
const headAck = ref(false)
const expanded = ref(false)
const cancelButton = ref<HTMLButtonElement | null>(null)
const retryButton = ref<HTMLButtonElement | null>(null)
let loadGeneration = 0

const counts = computed(() => preview.value?.counts ?? null)
const entries = computed(() => preview.value?.entries ?? [])
const visibleEntries = computed(() => (expanded.value ? entries.value : entries.value.slice(0, 20)))
const hiddenEntryCount = computed(() => Math.max(0, entries.value.length - 20))
const conflictPaths = computed(() => entries.value
  .filter((entry) => Boolean(entry.conflictReason))
  .map((entry) => entry.path))
const skipConflicts = computed(() => counts.value?.skipConflicts ?? 0)
const conflictAckRequired = computed(() => skipConflicts.value > 0)
/**
 * The Runtime requires the acknowledgement list to cover every reported conflict. When the
 * runtime-capped preview cannot enumerate them all, the honest state is "cannot submit".
 */
const conflictAckIncomplete = computed(() => conflictAckRequired.value
  && conflictPaths.value.length < skipConflicts.value)
const headStatus = computed(() => preview.value?.headFingerprint.status ?? 'unknown')
const headAckRequired = computed(() => headStatus.value === 'changed' || headStatus.value === 'unknown')
const countsAvailable = computed(() => counts.value !== null)

const canSubmit = computed(() => Boolean(preview.value)
  && countsAvailable.value
  && !loading.value
  && !loadError.value
  && !conflictAckIncomplete.value
  && (!conflictAckRequired.value || conflictAck.value)
  && (!headAckRequired.value || headAck.value)
  && !props.busy)

function conflictLabel(reason: string | undefined): string {
  if (reason === 'CONTENT_CHANGED') return t('chat.checkpointConflictContentChanged')
  return reason ?? ''
}

function entryActionLabel(entry: RevertPreviewEntry): string {
  if (entry.action === 'restore') return t('chat.checkpointEntryRestore')
  if (entry.action === 'delete') return t('chat.checkpointEntryDelete')
  return t('chat.checkpointEntryUnknownAction')
}

function focusCancel() {
  void nextTick(() => cancelButton.value?.focus())
}

async function loadPreview() {
  const runId = props.runId
  if (!runId) return
  const generation = ++loadGeneration
  loading.value = true
  loadError.value = null
  preview.value = null
  conflictAck.value = false
  headAck.value = false
  expanded.value = false
  try {
    const result = await api.previewRunCheckpointRevert(runId)
    if (generation !== loadGeneration || props.runId !== runId) return
    preview.value = result
  } catch (cause) {
    if (generation !== loadGeneration || props.runId !== runId) return
    loadError.value = cause instanceof ApiError
      ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
      : t('chat.checkpointPreviewFailed')
    logger.warn('Failed to load run checkpoint revert preview', cause)
  } finally {
    if (generation === loadGeneration) {
      loading.value = false
      // The preview replaces the loading state: (re)anchor the conservative default.
      if (loadError.value) {
        void nextTick(() => retryButton.value?.focus())
      } else {
        focusCancel()
      }
    }
  }
}

watch(() => [props.show, props.runId] as const, ([show]) => {
  if (show) {
    void loadPreview()
  } else {
    loadGeneration += 1
  }
}, { immediate: true })

function handleShowChange(value: boolean) {
  if (!value) handleClose()
}

function handleClose() {
  if (props.busy) return
  emit('close')
}

function submit() {
  const current = preview.value
  if (!current || !canSubmit.value) return
  emit('confirm', {
    acknowledgeConflicts: conflictAckRequired.value ? conflictPaths.value : [],
    acknowledgeHeadChange: headAckRequired.value && headAck.value,
  })
}
</script>

<template>
  <CheckpointDialogShell
    :show="show"
    :title="t('chat.checkpointPreviewTitle')"
    :description="t('chat.checkpointPreviewDescription')"
    @update:show="handleShowChange"
    @initial-focus="focusCancel"
  >
    <div class="space-y-4">
      <p v-if="loading" data-testid="revert-preview-loading" class="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
        {{ t('chat.checkpointPreviewLoading') }}
      </p>

      <div v-else-if="loadError" data-testid="revert-preview-error" class="space-y-3">
        <p class="text-sm text-destructive" role="alert">{{ loadError }}</p>
        <button
          type="button"
          ref="retryButton"
          data-testid="revert-preview-retry"
          class="inline-flex min-h-8 items-center rounded-lg border px-3 py-1.5 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @click="loadPreview"
        >
          {{ t('chat.checkpointPreviewRetry') }}
        </button>
      </div>

      <template v-else-if="preview">
        <div v-if="counts" data-testid="revert-preview-counts" class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div class="rounded-lg border bg-muted/20 p-2 text-center">
            <div class="text-xs text-muted-foreground">{{ t('chat.checkpointPreviewRestore') }}</div>
            <div data-testid="revert-preview-restore-count" class="text-lg font-semibold">{{ counts.restore }}</div>
          </div>
          <div class="rounded-lg border bg-muted/20 p-2 text-center">
            <div class="text-xs text-muted-foreground">{{ t('chat.checkpointPreviewDelete') }}</div>
            <div data-testid="revert-preview-delete-count" class="text-lg font-semibold">{{ counts.delete }}</div>
          </div>
          <div class="rounded-lg border bg-muted/20 p-2 text-center">
            <div class="text-xs text-muted-foreground">{{ t('chat.checkpointPreviewSkipConflicts') }}</div>
            <div data-testid="revert-preview-skip-count" class="text-lg font-semibold">{{ counts.skipConflicts }}</div>
          </div>
          <div class="rounded-lg border bg-muted/20 p-2 text-center">
            <div class="text-xs text-muted-foreground">{{ t('chat.checkpointPreviewNoop') }}</div>
            <div data-testid="revert-preview-noop-count" class="text-lg font-semibold">{{ counts.noop }}</div>
          </div>
        </div>
        <p v-else data-testid="revert-preview-counts-unavailable" class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="alert">
          {{ t('chat.checkpointPreviewCountsUnavailable') }}
        </p>

        <div data-testid="revert-preview-paths">
          <p class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('chat.checkpointPreviewPathsTitle') }}</p>
          <ul v-if="visibleEntries.length > 0" class="max-h-48 space-y-1 overflow-y-auto rounded-lg border bg-muted/10 p-2 text-xs">
            <li v-for="entry in visibleEntries" :key="`${entry.action}:${entry.path}`" class="flex flex-wrap items-baseline gap-1.5">
              <span class="rounded border px-1 py-0.5 text-[10px] text-muted-foreground">{{ entryActionLabel(entry) }}</span>
              <span class="break-all font-mono">{{ entry.path }}</span>
              <span v-if="entry.oldPath" class="text-muted-foreground">← {{ entry.oldPath }}</span>
              <span v-if="entry.conflictReason" data-testid="revert-preview-conflict" class="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-0.5 text-[10px]">
                {{ t('chat.checkpointPreviewConflictBadge') }}: {{ conflictLabel(entry.conflictReason) }}
              </span>
            </li>
          </ul>
          <p v-else data-testid="revert-preview-no-entries" class="text-sm text-muted-foreground">{{ t('chat.checkpointPreviewNoEntries') }}</p>
          <button
            v-if="hiddenEntryCount > 0"
            type="button"
            data-testid="revert-preview-expand"
            class="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            @click="expanded = !expanded"
          >
            <component :is="expanded ? ChevronUp : ChevronDown" class="size-3.5" aria-hidden="true" />
            {{ expanded ? t('chat.checkpointPreviewCollapse') : t('chat.checkpointPreviewExpand') }}
          </button>
          <p v-if="preview.truncated" data-testid="revert-preview-truncated" class="mt-1 text-xs text-muted-foreground">
            {{ t('chat.checkpointPreviewTruncated') }}
          </p>
        </div>

        <p
          v-if="preview.sealedWithLiveJobs"
          data-testid="revert-preview-live-jobs"
          class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          {{ t('chat.checkpointPreviewLiveJobs') }}
        </p>

        <p
          v-if="headAckRequired"
          data-testid="revert-preview-head-warning"
          class="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{{ headStatus === 'changed' ? t('chat.checkpointPreviewHeadChanged') : t('chat.checkpointPreviewHeadUnknown') }}</span>
        </p>

        <div class="space-y-2">
          <label
            v-if="conflictAckRequired"
            class="flex items-start gap-2 text-sm"
          >
            <input
              v-model="conflictAck"
              data-testid="revert-preview-conflict-ack"
              type="checkbox"
              class="mt-0.5 size-4 rounded border"
              :disabled="conflictAckIncomplete"
            />
            <span>{{ t('chat.checkpointPreviewConflictAck') }}</span>
          </label>
          <p v-if="conflictAckIncomplete" data-testid="revert-preview-conflict-incomplete" class="text-xs text-destructive" role="alert">
            {{ t('chat.checkpointPreviewConflictIncomplete') }}
          </p>
          <label
            v-if="headAckRequired"
            class="flex items-start gap-2 text-sm"
          >
            <input
              v-model="headAck"
              data-testid="revert-preview-head-ack"
              type="checkbox"
              class="mt-0.5 size-4 rounded border"
            />
            <span>{{ t('chat.checkpointPreviewHeadAck') }}</span>
          </label>
        </div>

        <p v-if="error" data-testid="revert-preview-submit-error" class="text-sm text-destructive" role="alert">{{ error }}</p>

        <div class="flex flex-wrap justify-end gap-2 border-t pt-3">
          <button
            ref="cancelButton"
            type="button"
            data-testid="revert-preview-cancel"
            class="inline-flex min-h-9 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            :disabled="busy"
            @click="handleClose"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            data-testid="revert-preview-confirm"
            class="inline-flex min-h-9 items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canSubmit"
            @click="submit"
          >
            <LoaderCircle v-if="busy" class="mr-1.5 size-4 animate-spin" aria-hidden="true" />
            {{ t('chat.checkpointPreviewConfirm') }}
          </button>
        </div>
      </template>
    </div>
  </CheckpointDialogShell>
</template>
