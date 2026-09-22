<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '../../composables/api'
import { logger } from '../../lib/logger'

const props = defineProps<{ open: boolean; workspaceId: string }>()
const emit = defineEmits<{ close: []; completed: [] }>()

const { t } = useI18n()

const path = ref('')
const entries = ref<Array<{ name: string; kind: string; readable: boolean; size: number }>>([])
const error = ref<string | null>(null)
const loading = ref(false)
const importing = ref(false)
const excludeRules = ref('node_modules\ntarget\n.venv\n.tmp')
const importId = ref<string | null>(null)
const status = ref<string | null>(null)
const errorCode = ref<string | null>(null)
const recovered = ref(false)
let pollTimer: ReturnType<typeof setTimeout> | undefined

const TERMINAL = ['completed', 'cancelled', 'failed']
const ACTIVE = ['queued', 'running']

/** PLAN-0384 V5: import status is durable, so it is always shown through i18n labels. */
const statusLabel = computed(() => {
  switch (status.value) {
    case 'queued': return t('workspace.importQueued')
    case 'running': return t('workspace.importRunning')
    case 'completed': return t('workspace.importCompleted')
    case 'cancelled': return t('workspace.importCancelled')
    case 'failed': return t('workspace.importFailed')
    default: return status.value ?? ''
  }
})

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = undefined
  }
}

async function browse(nextPath = path.value) {
  if (!nextPath.trim()) return
  loading.value = true
  error.value = null
  try {
    const result = await api.listImportSources(nextPath.trim())
    path.value = result.path
    entries.value = result.entries
  } catch (cause) {
    logger.warn('Failed to read import source directory', cause)
    error.value = cause instanceof Error ? cause.message : t('workspace.importSourceFailed')
  } finally {
    loading.value = false
  }
}

function openEntry(entry: { name: string; kind: string }) {
  if (entry.kind === 'directory') void browse(`${path.value.replace(/[\\/]$/, '')}/${entry.name}`)
}

async function startImport() {
  if (!path.value || importing.value) return
  importing.value = true
  error.value = null
  errorCode.value = null
  recovered.value = false
  status.value = 'queued'
  try {
    const result = await api.startWorkspaceImport(props.workspaceId, {
      sourcePath: path.value,
      excludeRules: excludeRules.value.split(/\r?\n/).map((rule) => rule.trim()).filter(Boolean),
      idempotencyKey: crypto.randomUUID(),
    })
    importId.value = String(result.importId)
    await poll()
  } catch (cause) {
    logger.warn('Failed to start the workspace import', cause)
    error.value = cause instanceof Error ? cause.message : t('workspace.importStartFailed')
    importing.value = false
  }
}

async function poll() {
  if (!importId.value) return
  try {
    const result = await api.getWorkspaceImport(importId.value)
    applyStatus(result)
  } catch (cause) {
    logger.warn('Failed to poll the workspace import', cause)
    error.value = cause instanceof Error ? cause.message : t('workspace.importStartFailed')
    importing.value = false
    return
  }
  if (TERMINAL.includes(status.value ?? '')) {
    importing.value = false
    if (status.value === 'completed') emit('completed')
    return
  }
  pollTimer = setTimeout(() => void poll(), 1000)
}

function applyStatus(result: Record<string, unknown>) {
  status.value = String(result.status ?? 'unknown')
  errorCode.value = result.errorCode ? String(result.errorCode) : null
}

/** PLAN-0384 V5: recover an in-flight import after a reload/disconnect using durable records. */
async function recover() {
  try {
    const records = await api.listWorkspaceImports(props.workspaceId)
    const active = records
      .filter((record) => ACTIVE.includes(String(record.status)))
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0]
    if (!active) return
    importId.value = String(active.importId)
    applyStatus(active)
    importing.value = true
    recovered.value = true
    pollTimer = setTimeout(() => void poll(), 1000)
  } catch (cause) {
    // Recovery is best-effort; a missing list endpoint must not block a fresh import.
    logger.warn('Failed to recover in-flight workspace imports', cause)
  }
}

async function cancelImport() {
  if (!importId.value || !importing.value) return
  try {
    const result = await api.cancelWorkspaceImport(importId.value)
    stopPolling()
    applyStatus(result)
    importing.value = false
  } catch (cause) {
    logger.warn('Failed to cancel the workspace import', cause)
    error.value = cause instanceof Error ? cause.message : t('workspace.importCancelFailed')
  }
}

function close() {
  emit('close')
}

watch(() => props.open, (open) => {
  if (!open) {
    stopPolling()
    return
  }
  error.value = null
  status.value = null
  errorCode.value = null
  importId.value = null
  importing.value = false
  recovered.value = false
  void recover()
}, { immediate: true })

onBeforeUnmount(stopPolling)
</script>

<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
    <section
      class="w-full max-w-xl rounded-lg border bg-background p-5 shadow-xl"
      role="dialog"
      aria-modal="true"
      data-testid="workspace-import-dialog"
    >
      <div class="flex items-center justify-between">
        <h2 class="text-base font-semibold">{{ t('workspace.importDialogTitle') }}</h2>
        <button type="button" class="text-muted-foreground" data-testid="workspace-import-close" @click="close">
          {{ t('workspace.importClose') }}
        </button>
      </div>
      <div class="mt-4 flex gap-2">
        <input
          v-model="path"
          class="min-w-0 flex-1 rounded border bg-background px-2 py-1.5 text-sm"
          :placeholder="t('workspace.sourcePathPlaceholder')"
          data-testid="workspace-import-path"
          :disabled="importing"
        />
        <button
          type="button"
          class="rounded border px-3 py-1.5 text-sm"
          data-testid="workspace-import-read"
          :disabled="loading || importing || !path"
          @click="browse()"
        >{{ t('workspace.readDirectory') }}</button>
      </div>
      <p v-if="error" class="mt-3 text-sm text-destructive" data-testid="workspace-import-error">{{ error }}</p>
      <div class="mt-3 max-h-48 overflow-auto rounded border text-sm" data-testid="workspace-import-entries">
        <button
          v-for="entry in entries"
          :key="entry.name"
          type="button"
          class="block w-full border-b px-3 py-2 text-left last:border-0 hover:bg-muted/50"
          :disabled="importing || entry.kind !== 'directory'"
          @click="openEntry(entry)"
        >
          {{ entry.kind === 'directory' ? '📁' : '📄' }} {{ entry.name }}
        </button>
        <p v-if="entries.length === 0" class="p-3 text-muted-foreground">{{ t('workspace.sourceEmpty') }}</p>
      </div>
      <label class="mt-3 block text-xs text-muted-foreground">
        {{ t('workspace.importExcludeRules') }}
        <textarea
          v-model="excludeRules"
          class="mt-1 min-h-20 w-full rounded border bg-background p-2 text-sm"
          data-testid="workspace-import-exclude"
          :disabled="importing"
        />
      </label>
      <p v-if="recovered" class="mt-2 text-xs text-muted-foreground" data-testid="workspace-import-recovered">
        {{ t('workspace.importRecovered') }}
      </p>
      <div class="mt-4 flex items-center justify-between gap-2">
        <span v-if="status" class="text-xs text-muted-foreground" data-testid="workspace-import-status">
          {{ t('workspace.importStatusLabel') }}：{{ statusLabel }}<template v-if="errorCode"> · {{ errorCode }}</template>
        </span>
        <span v-else />
        <div class="flex items-center gap-2">
          <button
            v-if="importing"
            type="button"
            class="rounded border px-3 py-1.5 text-sm"
            data-testid="workspace-import-cancel"
            @click="cancelImport"
          >{{ t('workspace.importCancel') }}</button>
          <button
            type="button"
            class="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
            data-testid="workspace-import-start"
            :disabled="!path || importing"
            @click="startImport"
          >{{ t('workspace.importStart') }}</button>
        </div>
      </div>
    </section>
  </div>
</template>
