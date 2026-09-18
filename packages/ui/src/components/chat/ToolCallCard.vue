<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Diagnostic, ToolCall } from '../../types'
import { ApiError, api } from '../../composables/api'
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

const VISIBLE_DIAGNOSTICS = 3

const diagnostics = computed<Diagnostic[]>(() => props.toolCall.diagnostics?.items ?? [])
const hasDiagnostics = computed(() => diagnostics.value.length > 0)
const diagnosticsTotal = computed(() =>
  Math.max(props.toolCall.diagnostics?.total ?? 0, diagnostics.value.length),
)
const hiddenDiagnosticsCount = computed(() =>
  Math.max(diagnostics.value.length - VISIBLE_DIAGNOSTICS, 0),
)

// Card body: collapsed by default; a tool result carrying diagnostics opens
// the card so failures are visible without a click (PLAN-0342 decision #7).
const expanded = ref(false)
// Raw Arguments/Result fallback has its own toggle and stays collapsed when
// the structured diagnostics block is present.
const rawExpanded = ref(false)
const diagnosticsExpanded = ref(false)

watch(
  hasDiagnostics,
  (present) => {
    if (present) expanded.value = true
  },
  { immediate: true },
)

const visibleDiagnostics = computed(() =>
  diagnosticsExpanded.value ? diagnostics.value : diagnostics.value.slice(0, VISIBLE_DIAGNOSTICS),
)

function formatLocation(item: Diagnostic): string {
  if (!item.file) return ''
  if (item.line === null) return item.file
  if (item.column === null) return `${item.file}:${item.line}`
  return `${item.file}:${item.line}:${item.column}`
}

function severityClass(severity: Diagnostic['severity']): string {
  return severity === 'error' ? 'text-destructive' : 'text-muted-foreground'
}

function diagnosticKey(item: Diagnostic, index: number): string {
  return `${item.file ?? ''}:${item.line ?? ''}:${item.column ?? ''}:${index}`
}

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

// PLAN-0344：durable job 卡片——档案（jobSummary）给状态与 jobId，
// 输出按字节游标从 CP 续看端点分页拉取（真源仍是容器文件）。
const JOB_TOOL_NAMES = [
  'start_background_process',
  'get_background_process',
  'cancel_background_process',
]
const isJobCard = computed(
  () => JOB_TOOL_NAMES.includes(props.toolCall.name) || !!props.toolCall.jobSummary,
)
const jobSummary = computed(() => props.toolCall.jobSummary)
const jobOutput = ref('')
const jobNextOffset = ref(0)
const jobSizeBytes = ref(0)
const jobTruncated = ref(false)
const jobLoaded = ref(false)
const jobLoading = ref(false)
const jobError = ref<string | null>(null)
const jobHasMore = computed(() => jobLoaded.value && jobNextOffset.value < jobSizeBytes.value)

async function loadJobOutput(reset: boolean) {
  const itemId = jobSummary.value?.itemId
  if (!itemId || jobLoading.value) return
  jobLoading.value = true
  jobError.value = null
  try {
    const chunk = await api.getJobOutput(itemId, {
      stream: 'stdout',
      offset: reset ? 0 : jobNextOffset.value,
      limit: 64 * 1024,
    })
    jobOutput.value = reset ? chunk.data : jobOutput.value + chunk.data
    jobNextOffset.value = chunk.nextOffset
    jobSizeBytes.value = chunk.sizeBytes
    jobTruncated.value = chunk.truncated
    jobLoaded.value = true
  } catch (err) {
    if (err instanceof ApiError) {
      jobError.value =
        err.problem.code === 'JOB_OUTPUT_LOST'
          ? t('chat.jobOutputLost')
          : err.problem.code === 'JOB_OUTPUT_EXPIRED'
            ? t('chat.jobOutputExpired')
            : err.problem.code === 'RUNTIME_UNAVAILABLE'
              ? t('chat.jobOutputUnavailable')
              : (err.problem.title ?? err.message)
    } else {
      jobError.value = String(err)
    }
  } finally {
    jobLoading.value = false
  }
}
</script>

<template>
  <div class="my-2 overflow-hidden rounded-lg border bg-card">
    <button
      class="flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-accent/50"
      :aria-expanded="expanded"
      data-testid="tool-card-toggle"
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
      <div v-if="hasDiagnostics" class="space-y-1.5" data-testid="tool-diagnostics">
        <div class="flex items-baseline justify-between gap-2">
          <span class="font-medium text-foreground">{{ t('chat.toolDiagnosticsTitle') }}</span>
          <span class="text-muted-foreground">
            {{
              t('chat.toolDiagnosticsSummary', {
                total: diagnosticsTotal,
                shown: diagnostics.length,
              })
            }}
          </span>
        </div>
        <ul class="space-y-1">
          <li
            v-for="(item, index) in visibleDiagnostics"
            :key="diagnosticKey(item, index)"
            class="flex items-baseline gap-1 font-mono"
            :data-testid="`diagnostic-item-${index}`"
          >
            <span
              class="shrink-0 font-medium"
              :class="severityClass(item.severity)"
            >{{ item.severity }}</span>
            <span
              v-if="formatLocation(item)"
              class="shrink-0 text-muted-foreground"
            >{{ formatLocation(item) }}</span>
            <span class="min-w-0 flex-1 truncate text-foreground" :title="item.message">{{ item.message }}</span>
          </li>
        </ul>
        <button
          v-if="hiddenDiagnosticsCount > 0 && !diagnosticsExpanded"
          type="button"
          class="rounded border px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          :aria-expanded="diagnosticsExpanded"
          data-testid="diagnostics-more"
          @click="diagnosticsExpanded = true"
        >
          {{ t('chat.toolDiagnosticsMore', { count: hiddenDiagnosticsCount }) }}
        </button>
      </div>

      <div v-if="isJobCard" class="space-y-1.5" data-testid="job-output-panel">
        <div class="flex items-center gap-2">
          <span class="font-medium text-foreground">{{ t('chat.jobOutputTitle') }}</span>
          <span
            v-if="jobSummary?.status"
            class="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
            data-testid="job-status"
          >{{ t(`chat.jobStatus.${jobSummary.status}`) }}</span>
          <button
            type="button"
            class="ml-auto rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
            :disabled="jobLoading"
            data-testid="job-output-load"
            @click="loadJobOutput(true)"
          >
            {{ jobLoaded ? t('chat.jobOutputReload') : t('chat.jobOutputLoad') }}
          </button>
        </div>
        <p
          v-if="jobSummary?.jobId"
          class="truncate font-mono text-muted-foreground"
          :title="jobSummary.jobId"
        >{{ jobSummary.jobId }}</p>
        <pre
          v-if="jobLoaded"
          data-testid="job-output-data"
          class="max-h-64 overflow-auto rounded bg-muted/30 p-2 font-mono whitespace-pre-wrap break-all"
        >{{ jobOutput || t('chat.jobOutputEmpty') }}</pre>
        <p v-if="jobTruncated" class="text-muted-foreground">{{ t('chat.jobOutputTruncated') }}</p>
        <button
          v-if="jobHasMore"
          type="button"
          class="rounded border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
          :disabled="jobLoading"
          data-testid="job-output-more"
          @click="loadJobOutput(false)"
        >
          {{ t('chat.jobOutputMore') }}
        </button>
        <p v-if="jobError" class="text-destructive" data-testid="job-output-error">{{ jobError }}</p>
      </div>

      <div v-if="hasDiagnostics">
        <button
          type="button"
          class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          :aria-expanded="rawExpanded"
          data-testid="raw-output-toggle"
          @click="rawExpanded = !rawExpanded"
        >
          <ChevronDown
            class="size-3 transition-transform"
            :class="rawExpanded ? 'rotate-180' : ''"
            aria-hidden="true"
          />
          {{ t('chat.toolRawOutput') }}
        </button>
      </div>

      <div v-if="!hasDiagnostics || rawExpanded" class="space-y-2">
        <div class="font-mono text-muted-foreground">
          <div class="mb-1 font-medium text-foreground">Arguments</div>
          <pre data-testid="raw-arguments" class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all">{{ typeof toolCall.arguments === 'string' ? toolCall.arguments : JSON.stringify(toolCall.arguments, null, 2) }}</pre>
        </div>
        <div v-if="toolCall.result" class="font-mono">
          <div class="mb-1 font-medium text-foreground">Result</div>
          <pre data-testid="raw-result" class="rounded bg-muted/30 p-2 whitespace-pre-wrap break-all">{{ typeof toolCall.result === 'string' ? toolCall.result.substring(0, 2000) : JSON.stringify(toolCall.result, null, 2) }}</pre>
          <p v-if="toolCall.result.length > 2000" class="mt-1 text-muted-foreground">Output truncated ({{ toolCall.result.length }} chars total)</p>
        </div>
        <div v-if="toolCall.error" class="font-mono">
          <div class="mb-1 font-medium text-destructive">Error</div>
          <pre class="rounded bg-destructive/10 p-2 whitespace-pre-wrap break-all text-destructive">{{ toolCall.error }}</pre>
        </div>
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
