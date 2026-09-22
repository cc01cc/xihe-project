<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '../../stores/auth'
import { api, ApiError } from '../../composables/api'
import type {
  WorkspaceBackendMaturity,
  WorkspaceCapabilityPreflight,
  WorkspaceDirectAttachExecutionMode,
  WorkspaceStorageMode,
} from '../../types'
import { logger } from '../../lib/logger'
import { toast } from 'vue-sonner'
import Dialog from '../ui/dialog/Dialog.vue'
import DialogContent from '../ui/dialog/DialogContent.vue'
import DialogHeader from '../ui/dialog/DialogHeader.vue'
import DialogTitle from '../ui/dialog/DialogTitle.vue'
import DialogDescription from '../ui/dialog/DialogDescription.vue'
import DialogFooter from '../ui/dialog/DialogFooter.vue'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Checkbox } from '../ui/checkbox'
import { ArrowLeft, FileText, FolderOpen, LoaderCircle, ShieldAlert } from '@lucide/vue'

/**
 * PLAN-0384 T1.1/T1.3/T1.4: progressive single dialog for adding a Workspace.
 *
 * Steps follow `spec/ui-flow.md`: storage mode → (direct-attach only) Runtime-visible
 * source browser → execution mode (real capability preflight for direct-attach) → confirm.
 * The browser never fabricates a host path (no `File.path`, no native picker); directory
 * selection goes through the Runtime-visible source browser.
 */
type Step = 'select_storage_mode' | 'select_source' | 'select_execution_mode' | 'confirm_workspace'

interface SourceEntry {
  name: string
  kind: string
  readable: boolean
  size: number
}

const props = withDefaults(defineProps<{
  open: boolean
}>(), {
  open: false,
})

const emit = defineEmits<{
  close: []
  created: [workspaceId: string]
}>()

const { t } = useI18n()
const auth = useAuthStore()

const step = ref<Step>('select_storage_mode')
const storageMode = ref<WorkspaceStorageMode>('managed_import')
const executionMode = ref<WorkspaceDirectAttachExecutionMode>('windows-mxc')
const name = ref('')
const description = ref('')
const saving = ref(false)
const submitError = ref('')
const idempotencyKey = ref<string | null>(null)

// Source browser (Runtime-visible directory tree).
const sourcePath = ref('')
const sourceEntries = ref<SourceEntry[]>([])
const sourceLoading = ref(false)
const sourceError = ref('')
const selectedHostPath = ref('')

// Runtime capability preflight (direct-attach only).
const preflightLoading = ref(false)
const preflightError = ref('')
const mxcPreflight = ref<WorkspaceCapabilityPreflight | null>(null)
const hostPreflight = ref<WorkspaceCapabilityPreflight | null>(null)

const hostRiskAck = ref(false)

const isDirectAttach = computed(() => storageMode.value === 'direct_attach')
const mxcAvailable = computed(() => mxcPreflight.value?.available === true)
const hostAvailable = computed(() => hostPreflight.value?.available === true)

const mxcCardDisabled = computed(() => {
  if (!isDirectAttach.value) return false
  return preflightLoading.value || !mxcAvailable.value
})

const hostCardDisabled = computed(() => {
  if (!isDirectAttach.value) return false
  return preflightLoading.value || !hostAvailable.value
})

const executionSelectionValid = computed(() => {
  if (!isDirectAttach.value) return true
  return executionMode.value === 'windows-mxc' ? mxcAvailable.value : hostAvailable.value
})

const showMxcGuidance = computed(() => (
  isDirectAttach.value
  && !preflightLoading.value
  && mxcPreflight.value !== null
  && !mxcAvailable.value
))

const storageModeLabel = computed(() => (
  isDirectAttach.value ? t('workspace.directAttach') : t('workspace.managedImport')
))

const executionModeLabel = computed(() => {
  // Managed import stays on the implemented backend contract (docker only);
  // the Docker execution line is postponed, so it is shown as such, not as MXC.
  if (!isDirectAttach.value) return t('workspace.executionModeDocker')
  return executionMode.value === 'windows-mxc'
    ? t('workspace.executionModeMxc')
    : t('workspace.executionModeHost')
})

const activePreflight = computed(() => (
  executionMode.value === 'windows-mxc' ? mxcPreflight.value : hostPreflight.value
))

const executionMaturity = computed(() => {
  if (!isDirectAttach.value) return '—'
  return maturityLabel(activePreflight.value?.maturity)
})

const executionAvailability = computed(() => {
  if (!isDirectAttach.value) return t('workspace.dockerPostponed')
  const preflight = activePreflight.value
  if (!preflight) return t('workspace.capabilityUnknown')
  if (preflight.available) return t('workspace.capabilityAvailable')
  return `${t('workspace.capabilityUnavailable')} · ${preflight.reason ?? t('workspace.capabilityUnknownReason')}`
})

const canSubmit = computed(() => {
  if (saving.value) return false
  if (!name.value.trim()) return false
  if (isDirectAttach.value) {
    if (!selectedHostPath.value.trim()) return false
    if (!executionSelectionValid.value) return false
  }
  if (executionMode.value === 'windows-host' && !hostRiskAck.value) return false
  return true
})

function maturityLabel(maturity: WorkspaceBackendMaturity | undefined | null): string {
  if (maturity === 'experimental') return t('workspace.maturityExperimental')
  if (maturity === 'preview') return t('workspace.maturityPreview')
  if (maturity === 'stable') return t('workspace.maturityStable')
  return t('workspace.capabilityUnknown')
}

function reset() {
  step.value = 'select_storage_mode'
  storageMode.value = 'managed_import'
  executionMode.value = 'windows-mxc'
  name.value = ''
  description.value = ''
  saving.value = false
  submitError.value = ''
  idempotencyKey.value = null
  sourcePath.value = ''
  sourceEntries.value = []
  sourceLoading.value = false
  sourceError.value = ''
  selectedHostPath.value = ''
  preflightLoading.value = false
  preflightError.value = ''
  mxcPreflight.value = null
  hostPreflight.value = null
  hostRiskAck.value = false
}

function selectStorageMode(mode: WorkspaceStorageMode) {
  storageMode.value = mode
  submitError.value = ''
  if (mode === 'direct_attach') {
    step.value = 'select_source'
  } else {
    // Managed import has no host path to probe and its backend is docker-only
    // (Runtime hydrate contract); skip the execution-mode step entirely.
    executionMode.value = 'windows-mxc'
    hostRiskAck.value = false
    step.value = 'confirm_workspace'
  }
}

function goBackFromExecution() {
  step.value = isDirectAttach.value ? 'select_source' : 'select_storage_mode'
}

function sourceReadReason(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.problem.code === 'RUNTIME_UNAVAILABLE') return t('workspace.runtimeUnavailable')
    return cause.problem.detail || cause.message
  }
  return cause instanceof Error ? cause.message : t('workspace.sourceReadFailed')
}

function preflightReason(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.problem.code === 'RUNTIME_UNAVAILABLE') return t('workspace.runtimeUnavailable')
    if (cause.problem.code === 'INVALID_EXECUTION_MODE') return t('workspace.preflightInvalidMode')
    if (cause.problem.code === 'INVALID_HOST_PATH') return t('workspace.preflightInvalidHostPath')
    return cause.problem.detail || cause.message
  }
  return cause instanceof Error ? cause.message : t('workspace.preflightFailed')
}

function createReason(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.problem.code === 'RUNTIME_UNAVAILABLE') return t('workspace.runtimeUnavailable')
    if (cause.problem.code === 'DIRECT_ATTACH_UNAVAILABLE') return t('workspace.directAttachUnavailable')
    if (cause.problem.code === 'IDEMPOTENCY_KEY_REUSE') return t('workspace.idempotencyConflict')
    return cause.problem.detail || cause.message
  }
  return cause instanceof Error ? cause.message : t('workspace.createFailed')
}

async function browse(nextPath = sourcePath.value) {
  const target = nextPath.trim()
  if (!target || sourceLoading.value) return
  sourceLoading.value = true
  sourceError.value = ''
  try {
    const result = await api.listImportSources(target)
    sourcePath.value = result.path
    sourceEntries.value = result.entries
  } catch (cause) {
    sourceError.value = sourceReadReason(cause)
    logger.error('Workspace source browse failed', cause)
  } finally {
    sourceLoading.value = false
  }
}

function openEntry(entry: SourceEntry) {
  if (entry.kind !== 'directory') return
  void browse(`${sourcePath.value.replace(/[\\/]+$/, '')}/${entry.name}`)
}

async function useThisDirectory() {
  const path = sourcePath.value.trim()
  if (!path) return
  selectedHostPath.value = path
  executionMode.value = 'windows-mxc'
  hostRiskAck.value = false
  step.value = 'select_execution_mode'
  await runPreflight()
}

async function runPreflight() {
  if (!isDirectAttach.value || !selectedHostPath.value) return
  preflightLoading.value = true
  preflightError.value = ''
  mxcPreflight.value = null
  hostPreflight.value = null
  try {
    const [mxc, host] = await Promise.all([
      api.preflightDirectAttach({ hostPath: selectedHostPath.value, executionMode: 'windows-mxc' }),
      api.preflightDirectAttach({ hostPath: selectedHostPath.value, executionMode: 'windows-host' }),
    ])
    mxcPreflight.value = mxc
    hostPreflight.value = host
    // Keep MXC as the recommended default. When it is unavailable the UI shows explicit
    // guidance and never silently switches to host execution (no automatic fallback).
    if (mxc.available) executionMode.value = 'windows-mxc'
  } catch (cause) {
    preflightError.value = preflightReason(cause)
    logger.error('Workspace capability preflight failed', cause)
  } finally {
    preflightLoading.value = false
  }
}

function chooseExecutionMode(mode: WorkspaceDirectAttachExecutionMode) {
  if (isDirectAttach.value) {
    if (mode === 'windows-mxc' && !mxcAvailable.value) return
    if (mode === 'windows-host' && !hostAvailable.value) return
  }
  executionMode.value = mode
  submitError.value = ''
}

/** Explicit user action from the MXC-unavailable guidance; never applied automatically. */
function switchToHostExecution() {
  if (isDirectAttach.value && !hostAvailable.value) return
  executionMode.value = 'windows-host'
}

function mxcCardStatus(): string {
  if (!isDirectAttach.value) return t('workspace.managedExecutionUnknown')
  if (preflightLoading.value) return t('workspace.preflightChecking')
  const preflight = mxcPreflight.value
  if (!preflight) return t('workspace.capabilityUnknown')
  return preflight.available
    ? t('workspace.capabilityAvailable')
    : `${t('workspace.capabilityUnavailable')} · ${preflight.reason ?? t('workspace.capabilityUnknownReason')}`
}

function hostCardStatus(): string {
  if (!isDirectAttach.value) return t('workspace.managedExecutionUnknown')
  if (preflightLoading.value) return t('workspace.preflightChecking')
  const preflight = hostPreflight.value
  if (!preflight) return t('workspace.capabilityUnknown')
  return preflight.available
    ? t('workspace.capabilityAvailable')
    : `${t('workspace.capabilityUnavailable')} · ${preflight.reason ?? t('workspace.capabilityUnknownReason')}`
}

async function handleCreate() {
  if (!canSubmit.value) return
  saving.value = true
  submitError.value = ''
  idempotencyKey.value ??= globalThis.crypto.randomUUID()
  try {
    const ws = await api.createWorkspace({
      name: name.value.trim(),
      description: description.value.trim() || null,
      storageMode: storageMode.value,
      // Managed import uses the server default executionMode (docker); only
      // direct-attach sends an explicit Windows execution mode.
      ...(isDirectAttach.value
        ? { executionMode: executionMode.value, hostPath: selectedHostPath.value }
        : {}),
      idempotencyKey: idempotencyKey.value,
    })
    auth.workspace = ws
    localStorage.setItem('xihe-workspace', JSON.stringify(ws))
    toast.success(t('workspace.createdToast'))
    emit('created', ws.id)
    emit('close')
    reset()
  } catch (cause) {
    submitError.value = createReason(cause)
    logger.error('Create workspace failed', cause)
    toast.error(submitError.value)
  } finally {
    saving.value = false
  }
}

function handleOpenChange(value: boolean) {
  if (!value) emit('close')
}

watch(() => props.open, (open) => {
  if (open) reset()
})
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogContent
      data-testid="workspace-create-dialog"
      class="max-h-[85vh] overflow-y-auto sm:max-w-lg"
    >
      <DialogHeader>
        <DialogTitle>{{ t('workspace.addWorkspaceTitle') }}</DialogTitle>
        <DialogDescription>{{ t('workspace.addWorkspaceDesc') }}</DialogDescription>
      </DialogHeader>

      <ol class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" data-testid="workspace-create-steps">
        <li :class="step === 'select_storage_mode' ? 'font-medium text-foreground' : ''">{{ t('workspace.stepStorageMode') }}</li>
        <li v-if="isDirectAttach" :class="step === 'select_source' ? 'font-medium text-foreground' : ''">{{ t('workspace.stepSource') }}</li>
        <li v-if="isDirectAttach" :class="step === 'select_execution_mode' ? 'font-medium text-foreground' : ''">{{ t('workspace.stepExecutionMode') }}</li>
        <li :class="step === 'confirm_workspace' ? 'font-medium text-foreground' : ''">{{ t('workspace.stepConfirm') }}</li>
      </ol>

      <div v-if="step === 'select_storage_mode'" data-testid="workspace-step-storage" class="grid gap-3">
        <button
          type="button"
          data-testid="workspace-storage-managed"
          class="rounded-md border p-3 text-left transition-colors hover:bg-accent"
          @click="selectStorageMode('managed_import')"
        >
          <span class="block text-sm font-semibold">{{ t('workspace.managedImport') }}</span>
          <span class="mt-1 block text-xs text-muted-foreground">{{ t('workspace.managedImportDesc') }}</span>
        </button>
        <button
          type="button"
          data-testid="workspace-storage-direct"
          class="rounded-md border p-3 text-left transition-colors hover:bg-accent"
          @click="selectStorageMode('direct_attach')"
        >
          <span class="block text-sm font-semibold">{{ t('workspace.directAttach') }}</span>
          <span class="mt-1 block text-xs text-muted-foreground">{{ t('workspace.directAttachDesc') }}</span>
        </button>
        <p class="text-xs text-muted-foreground">{{ t('workspace.addWorkspaceStorageHint') }}</p>
      </div>

      <div v-else-if="step === 'select_source'" data-testid="workspace-step-source" class="grid gap-3">
        <p class="text-sm font-medium">{{ t('workspace.hostDirectory') }}</p>
        <div class="flex gap-2">
          <Input
            v-model="sourcePath"
            data-testid="workspace-source-path"
            class="font-mono text-xs"
            :placeholder="t('workspace.sourcePathPlaceholder')"
            @keyup.enter="browse()"
          />
          <Button
            type="button"
            variant="outline"
            class="shrink-0"
            data-testid="workspace-source-read"
            :disabled="sourceLoading || !sourcePath.trim()"
            @click="browse()"
          >
            <LoaderCircle v-if="sourceLoading" class="animate-spin" aria-hidden="true" />
            {{ t('workspace.readDirectory') }}
          </Button>
        </div>
        <p v-if="sourceError" class="text-sm text-destructive" data-testid="workspace-source-error">{{ sourceError }}</p>
        <div data-testid="workspace-source-browser" class="max-h-52 overflow-auto rounded-md border text-sm">
          <p v-if="sourceEntries.length === 0" class="p-3 text-muted-foreground">{{ t('workspace.sourceEmpty') }}</p>
          <button
            v-for="entry in sourceEntries"
            :key="entry.name"
            type="button"
            class="flex w-full items-center gap-2 border-b px-3 py-2 text-left last:border-0 hover:bg-muted/50 disabled:opacity-60"
            :disabled="entry.kind !== 'directory'"
            :data-entry-kind="entry.kind"
            @click="openEntry(entry)"
          >
            <FolderOpen v-if="entry.kind === 'directory'" class="size-3.5 shrink-0" aria-hidden="true" />
            <FileText v-else class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="truncate">{{ entry.name }}</span>
          </button>
        </div>
        <p class="text-xs text-muted-foreground">{{ t('workspace.sourceBrowserHint') }}</p>
        <div class="flex justify-between gap-2">
          <Button type="button" variant="outline" @click="step = 'select_storage_mode'">
            <ArrowLeft class="size-3.5" aria-hidden="true" />
            {{ t('workspace.back') }}
          </Button>
          <Button
            type="button"
            data-testid="workspace-source-use"
            :disabled="sourceLoading || !sourcePath.trim()"
            @click="useThisDirectory"
          >
            {{ t('workspace.useThisDirectory') }}
          </Button>
        </div>
      </div>

      <div v-else-if="step === 'select_execution_mode'" data-testid="workspace-step-execution" class="grid gap-3">
        <p class="text-sm font-medium">{{ t('workspace.executionBackend') }}</p>
        <p v-if="preflightLoading" class="text-xs text-muted-foreground">{{ t('workspace.preflightChecking') }}</p>
        <p v-if="preflightError" class="text-sm text-destructive" data-testid="workspace-preflight-error">{{ preflightError }}</p>

        <button
          type="button"
          data-testid="workspace-execution-mode-mxc"
          class="rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          :class="executionMode === 'windows-mxc' ? 'border-primary' : ''"
          :disabled="mxcCardDisabled"
          :aria-pressed="executionMode === 'windows-mxc'"
          @click="chooseExecutionMode('windows-mxc')"
        >
          <span class="flex items-center gap-2 text-sm font-semibold">
            {{ t('workspace.executionModeMxc') }}
            <span v-if="mxcPreflight?.maturity === 'experimental'" class="rounded border border-amber-500/40 px-1.5 py-0.5 text-[10px] font-normal text-amber-600">
              {{ t('workspace.maturityExperimental') }}
            </span>
          </span>
          <span class="mt-1 block text-xs text-muted-foreground" data-testid="workspace-execution-mxc-status">{{ mxcCardStatus() }}</span>
        </button>

        <div v-if="showMxcGuidance" data-testid="workspace-mxc-guidance" class="rounded-md border border-amber-500/40 bg-amber-50/60 p-3 dark:bg-amber-950/30">
          <p class="text-xs text-muted-foreground">{{ t('workspace.mxcUnavailableGuidance') }}</p>
          <Button
            type="button"
            variant="outline"
            class="mt-2"
            data-testid="workspace-switch-to-host"
            :disabled="!hostAvailable"
            @click="switchToHostExecution"
          >
            {{ t('workspace.switchToHostExecution') }}
          </Button>
        </div>

        <button
          type="button"
          data-testid="workspace-execution-mode-host"
          class="rounded-md border p-3 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
          :class="executionMode === 'windows-host' ? 'border-primary' : ''"
          :disabled="hostCardDisabled"
          :aria-pressed="executionMode === 'windows-host'"
          @click="chooseExecutionMode('windows-host')"
        >
          <span class="flex items-center gap-2 text-sm font-semibold">
            <ShieldAlert class="size-3.5 text-amber-600" aria-hidden="true" />
            {{ t('workspace.executionModeHost') }}
          </span>
          <span class="mt-1 block text-xs text-muted-foreground">{{ t('workspace.hostBackendDesc') }}</span>
          <span class="mt-1 block text-xs text-muted-foreground" data-testid="workspace-execution-host-status">{{ hostCardStatus() }}</span>
        </button>

        <button
          type="button"
          data-testid="workspace-execution-mode-docker"
          class="rounded-md border p-3 text-left opacity-60"
          disabled
        >
          <span class="block text-sm font-semibold">{{ t('workspace.executionModeDocker') }}</span>
          <span class="mt-1 block text-xs text-muted-foreground">{{ t('workspace.dockerPostponed') }}</span>
        </button>

        <div class="flex justify-between gap-2">
          <Button type="button" variant="outline" @click="goBackFromExecution">
            <ArrowLeft class="size-3.5" aria-hidden="true" />
            {{ t('workspace.back') }}
          </Button>
          <Button
            type="button"
            data-testid="workspace-execution-next"
            :disabled="!executionSelectionValid"
            @click="step = 'confirm_workspace'"
          >
            {{ t('workspace.next') }}
          </Button>
        </div>
      </div>

      <div v-else data-testid="workspace-step-confirm" class="grid gap-4">
        <div class="grid gap-2">
          <label class="text-sm font-medium" for="ws-create-name">{{ t('workspace.nameLabel') }}</label>
          <Input id="ws-create-name" v-model="name" data-testid="workspace-create-name" :placeholder="t('workspace.namePlaceholder')" maxlength="120" />
        </div>
        <div class="grid gap-2">
          <label class="text-sm font-medium" for="ws-create-description">{{ t('workspace.descriptionLabel') }}</label>
          <Input id="ws-create-description" v-model="description" :placeholder="t('workspace.descriptionPlaceholder')" maxlength="500" />
        </div>

        <dl data-testid="workspace-create-summary" class="grid gap-2 rounded-md border p-3 text-xs">
          <div class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{{ t('workspace.summaryStorageMode') }}</dt>
            <dd>{{ storageModeLabel }}</dd>
          </div>
          <div v-if="isDirectAttach" class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{{ t('workspace.summaryDirectory') }}</dt>
            <dd class="break-all text-right font-mono" data-testid="workspace-summary-host-path">{{ selectedHostPath }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{{ t('workspace.summaryExecutionMode') }}</dt>
            <dd data-testid="workspace-summary-execution-mode">{{ executionModeLabel }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{{ t('workspace.summaryMaturity') }}</dt>
            <dd data-testid="workspace-summary-maturity">{{ executionMaturity }}</dd>
          </div>
          <div class="flex justify-between gap-3">
            <dt class="text-muted-foreground">{{ t('workspace.summaryAvailability') }}</dt>
            <dd data-testid="workspace-summary-availability" :class="isDirectAttach && !activePreflight?.available ? 'text-destructive' : ''">
              {{ executionAvailability }}
            </dd>
          </div>
        </dl>

        <div v-if="executionMode === 'windows-host'" class="rounded-md border border-amber-500/40 bg-amber-50/60 p-3 dark:bg-amber-950/30">
          <p class="text-xs font-medium">{{ t('workspace.hostRiskTitle') }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ t('workspace.hostRiskDescription') }}</p>
          <label class="mt-2 flex items-start gap-2 text-xs">
            <Checkbox
              data-testid="workspace-host-risk-ack"
              :model-value="hostRiskAck"
              @update:model-value="hostRiskAck = $event === true"
            />
            <span>{{ t('workspace.hostRiskAckLabel') }}</span>
          </label>
          <p v-if="!hostRiskAck" class="mt-1 text-xs text-destructive">{{ t('workspace.hostRiskAckRequired') }}</p>
        </div>

        <p v-if="submitError" class="text-sm text-destructive" data-testid="workspace-create-error">{{ submitError }}</p>

        <div class="flex justify-between gap-2">
          <Button type="button" variant="outline" @click="step = 'select_execution_mode'">
            <ArrowLeft class="size-3.5" aria-hidden="true" />
            {{ t('workspace.back') }}
          </Button>
          <Button
            type="button"
            data-testid="workspace-create-submit"
            :disabled="!canSubmit"
            @click="handleCreate"
          >
            <LoaderCircle v-if="saving" class="animate-spin" aria-hidden="true" />
            {{ t('workspace.create') }}
          </Button>
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('close')">{{ t('workspace.cancel') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
