<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlert, FileDiff, LoaderCircle, RefreshCw, X } from '@lucide/vue'
import { ApiError, api } from '../../composables/api'
import { logger } from '../../lib/logger'
import { useChatStore } from '../../stores/chat'
import { useCheckpointStore } from '../../stores/checkpoint'
import type { WorkspaceGitStatus } from '../../types'

/**
 * PLAN-0328 M3 T3.8 / spec/ui-ux §4.4: the two change views are rendered as two labeled tabs and
 * are NEVER merged into one list:
 * - `本轮变更` reads the checkpoint projection (`changedFiles`, authoritative for the run); and
 * - `待提交` reads the user repository `git status`.
 * They legitimately differ (manual edits, untracked files, external changes), which the shared
 * note states explicitly. A non-repository workspace has no pending-commit view at all and says so.
 */
const props = withDefaults(defineProps<{
  sessionId?: string | null
  workspaceId: string
}>(), {
  sessionId: null,
})

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const chatStore = useChatStore()
const checkpointStore = useCheckpointStore()

type DiffTab = 'run' | 'pending'
const activeTab = ref<DiffTab>('run')

const runId = computed(() => {
  const sessionId = props.sessionId
  if (!sessionId) return null
  return chatStore.getSessionRunId(sessionId)
    ?? checkpointStore.getLatestForSession(sessionId)?.runId
    ?? null
})
const runRecord = computed(() => (runId.value ? checkpointStore.get(runId.value) : undefined))
const runLoaded = computed(() => runRecord.value?.loaded === true)
const runCount = computed(() => (runLoaded.value ? runRecord.value?.changedCount ?? 0 : 0))
const runFiles = computed(() => (runLoaded.value ? runRecord.value?.changedFiles ?? [] : []))
const runStateLabel = computed(() => {
  const state = runRecord.value?.state
  if (!runLoaded.value || state === 'sealed') return ''
  if (state === 'degraded') return t('workspace.diffRunStateUnrollable')
  if (state === 'unsealed' || state === 'base') return t('workspace.diffRunStateUnsealed')
  if (state === 'expired') return t('workspace.diffRunStateExpired')
  if (state === 'none') return t('workspace.diffRunStateNone')
  return t('workspace.diffRunStateUnknown')
})

// The projection is authoritative for the run side, so it is always (re)read when the panel
// opens: an SSE annotation carries the lifecycle but not the file list.
function loadRunProjection() {
  const id = runId.value
  if (!id) return
  void checkpointStore.fetchCheckpoint(id, { sessionId: props.sessionId ?? undefined, force: true })
}

watch(runId, () => {
  loadRunProjection()
}, { immediate: true })

const pendingStatus = ref<WorkspaceGitStatus | null>(null)
const pendingLoading = ref(false)
const pendingError = ref<string | null>(null)
let pendingGeneration = 0

async function loadGitStatus() {
  const workspaceId = props.workspaceId
  if (!workspaceId) return
  const generation = ++pendingGeneration
  pendingLoading.value = true
  pendingError.value = null
  try {
    const status = await api.getWorkspaceGitStatus(workspaceId)
    if (generation !== pendingGeneration || props.workspaceId !== workspaceId) return
    pendingStatus.value = status
  } catch (cause) {
    if (generation !== pendingGeneration || props.workspaceId !== workspaceId) return
    pendingError.value = cause instanceof ApiError
      ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
      : t('workspace.diffPendingLoadFailed')
    logger.warn('Failed to load workspace git status', cause)
  } finally {
    if (generation === pendingGeneration) pendingLoading.value = false
  }
}

onMounted(loadGitStatus)
watch(() => props.workspaceId, () => {
  pendingGeneration += 1
  pendingStatus.value = null
  void loadGitStatus()
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col" data-testid="workspace-changes-panel">
    <div class="flex h-9 shrink-0 items-center gap-1 border-b px-2" role="tablist">
      <button
        type="button"
        role="tab"
        data-testid="workspace-diff-tab-run"
        :aria-selected="activeTab === 'run'"
        class="rounded px-2 py-1 text-xs font-medium transition-colors"
        :class="activeTab === 'run' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60'"
        @click="activeTab = 'run'"
      >
        {{ t('workspace.diffTabRun') }}
      </button>
      <button
        type="button"
        role="tab"
        data-testid="workspace-diff-tab-pending"
        :aria-selected="activeTab === 'pending'"
        class="rounded px-2 py-1 text-xs font-medium transition-colors"
        :class="activeTab === 'pending' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60'"
        @click="activeTab = 'pending'"
      >
        {{ t('workspace.diffTabPending') }}
      </button>
      <span class="flex-1" />
      <button
        v-if="activeTab === 'pending'"
        type="button"
        data-testid="workspace-diff-refresh"
        class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :title="t('workspace.diffRefresh')"
        :aria-label="t('workspace.diffRefresh')"
        :disabled="pendingLoading"
        @click="loadGitStatus"
      >
        <RefreshCw class="size-3.5" :class="pendingLoading ? 'animate-spin' : ''" aria-hidden="true" />
      </button>
      <button
        type="button"
        data-testid="workspace-changes-close"
        class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :title="t('workspace.closePanel')"
        :aria-label="t('workspace.closePanel')"
        @click="emit('close')"
      >
        <X class="size-3.5" aria-hidden="true" />
      </button>
    </div>

    <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <template v-if="activeTab === 'run'">
        <p v-if="!sessionId || !runId" data-testid="workspace-diff-run-empty" class="text-xs text-muted-foreground">
          {{ t('workspace.diffRunEmpty') }}
        </p>
        <div v-else-if="runRecord?.error && !runLoaded" data-testid="workspace-diff-run-error" class="space-y-1">
          <p class="text-xs text-destructive" role="alert">
            <span class="font-medium">{{ t('workspace.diffRunFailed') }}</span>
            <span class="mt-0.5 block break-all">{{ runRecord.error }}</span>
          </p>
          <button
            type="button"
            data-testid="workspace-diff-run-retry"
            class="rounded border px-2 py-0.5 text-xs transition-colors hover:bg-accent"
            @click="loadRunProjection"
          >
            {{ t('workspace.diffPendingRetry') }}
          </button>
        </div>
        <p v-else-if="!runLoaded" data-testid="workspace-diff-run-loading" class="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
          {{ t('workspace.diffRunLoading') }}
        </p>
        <template v-else>
          <p data-testid="workspace-diff-run-count" class="text-xs font-medium">
            {{ runCount }} {{ t('workspace.diffRunChangedUnit') }}
            <span v-if="runStateLabel" data-testid="workspace-diff-run-state" class="ml-1 font-normal text-muted-foreground">
              · {{ runStateLabel }}
            </span>
          </p>
          <ul
            v-if="runFiles.length > 0"
            data-testid="workspace-diff-run-list"
            class="space-y-1 rounded-lg border bg-muted/10 p-2 text-xs"
          >
            <li
              v-for="entry in runFiles"
              :key="`run:${entry.status}:${entry.path}`"
              data-testid="workspace-diff-run-entry"
              class="flex items-baseline gap-1.5"
            >
              <span class="rounded border px-1 py-0.5 text-[10px] text-muted-foreground">{{ entry.status }}</span>
              <span class="break-all font-mono">{{ entry.path }}</span>
            </li>
          </ul>
          <p
            v-else-if="runCount > 0"
            data-testid="workspace-diff-run-list-incomplete"
            class="text-xs text-muted-foreground"
          >
            {{ t('workspace.diffRunListIncomplete') }}
          </p>
          <p v-else data-testid="workspace-diff-run-clean" class="text-xs text-muted-foreground">
            {{ t('workspace.diffRunClean') }}
          </p>
        </template>
      </template>

      <template v-else>
        <p v-if="pendingLoading" data-testid="workspace-diff-pending-loading" class="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
          {{ t('workspace.diffPendingLoading') }}
        </p>
        <div v-else-if="pendingError" data-testid="workspace-diff-pending-error" class="space-y-1">
          <p class="flex items-start gap-1.5 text-xs text-destructive" role="alert">
            <CircleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{{ pendingError }}</span>
          </p>
          <button
            type="button"
            data-testid="workspace-diff-pending-retry"
            class="rounded border px-2 py-0.5 text-xs transition-colors hover:bg-accent"
            @click="loadGitStatus"
          >
            {{ t('workspace.diffPendingRetry') }}
          </button>
        </div>
        <p
          v-else-if="pendingStatus && !pendingStatus.isRepository"
          data-testid="workspace-diff-pending-no-repo"
          class="text-xs text-muted-foreground"
        >
          {{ t('workspace.diffPendingNoRepo') }}
        </p>
        <template v-else-if="pendingStatus">
          <p data-testid="workspace-diff-pending-count" class="text-xs font-medium">
            {{ pendingStatus.entries.length }} {{ t('workspace.diffPendingCountUnit') }}
          </p>
          <ul
            v-if="pendingStatus.entries.length > 0"
            data-testid="workspace-diff-pending-list"
            class="space-y-1 rounded-lg border bg-muted/10 p-2 text-xs"
          >
            <li
              v-for="entry in pendingStatus.entries"
              :key="`pending:${entry.status}:${entry.path}`"
              data-testid="workspace-diff-pending-entry"
              class="flex items-baseline gap-1.5"
            >
              <span class="rounded border px-1 py-0.5 text-[10px] text-muted-foreground">{{ entry.status }}</span>
              <span class="break-all font-mono">{{ entry.path }}</span>
            </li>
          </ul>
          <p v-else data-testid="workspace-diff-pending-empty" class="text-xs text-muted-foreground">
            {{ t('workspace.diffPendingEmpty') }}
          </p>
        </template>
      </template>

      <p
        data-testid="workspace-diff-difference-note"
        class="border-t pt-2 text-[11px] leading-relaxed text-muted-foreground"
      >
        <FileDiff class="mr-1 inline size-3 align-[-2px]" aria-hidden="true" />
        {{ t('workspace.diffDifferenceNote') }}
      </p>
    </div>
  </div>
</template>
