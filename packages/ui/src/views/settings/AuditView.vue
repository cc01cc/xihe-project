<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import BackToChatButton from '../../components/settings/BackToChatButton.vue'
import SettingsNav from '../../components/settings/SettingsNav.vue'
import { useOperationStore } from '../../stores/operations'
import type { OperationStatus } from '../../types'

const { t } = useI18n()
const operationStore = useOperationStore()
const statusFilter = ref<OperationStatus | ''>('')
const selectedOperationId = ref<string | null>(null)

const selectedTrace = computed(() => operationStore.selectedTrace)

async function loadOperations(page = 0) {
  await operationStore.load({
    status: statusFilter.value || undefined,
    page,
    size: 20,
  })
}

async function selectOperation(id: string) {
  selectedOperationId.value = id
  await operationStore.loadTrace(id)
}

function statusClass(status: string): string {
  if (status === 'completed') return 'text-emerald-600 dark:text-emerald-400'
  if (status === 'failed' || status === 'ambiguous') return 'text-destructive'
  if (status === 'waiting_for_approval') return 'text-amber-600 dark:text-amber-400'
  return 'text-muted-foreground'
}

function formatTime(value?: string | null): string {
  if (!value) return t('settings.auditNotAvailable')
  return new Date(value).toLocaleString()
}

function formatDuration(value?: number | null): string {
  return value === null || value === undefined ? t('settings.auditNotAvailable') : `${value}ms`
}

async function applyFilter() {
  selectedOperationId.value = null
  operationStore.clearTrace()
  await loadOperations()
}

async function changePage(delta: number) {
  const next = operationStore.page + delta
  if (next < 0 || next >= operationStore.totalPages) return
  await loadOperations(next)
}

onMounted(() => {
  void loadOperations()
})
</script>

<template>
  <BackToChatButton />
  <SettingsNav />
  <main class="mx-auto max-w-5xl px-4 py-6">
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="mb-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">XH / Ledger</p>
        <h1 data-testid="settings-audit-heading" class="text-xl font-semibold tracking-tight">
          {{ t('settings.auditTitle') }}
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.auditDesc') }}</p>
      </div>
      <label class="flex items-center gap-2 text-sm">
        <span class="text-muted-foreground">{{ t('settings.auditStatus') }}</span>
        <select
          v-model="statusFilter"
          data-testid="settings-audit-status"
          class="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          @change="applyFilter"
        >
          <option value="">{{ t('settings.auditAllStatuses') }}</option>
          <option value="accepted">{{ t('settings.auditAccepted') }}</option>
          <option value="running">{{ t('settings.auditRunning') }}</option>
          <option value="waiting_for_approval">{{ t('settings.auditWaiting') }}</option>
          <option value="completed">{{ t('settings.auditCompleted') }}</option>
          <option value="failed">{{ t('settings.auditFailed') }}</option>
          <option value="ambiguous">{{ t('settings.auditAmbiguous') }}</option>
        </select>
      </label>
    </header>

    <div v-if="operationStore.error" class="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      {{ operationStore.error }}
    </div>

    <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <section class="min-w-0 rounded-lg border border-border bg-card">
        <div class="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 class="text-sm font-medium">{{ t('settings.auditOperations') }}</h2>
          <span class="text-xs text-muted-foreground">{{ operationStore.totalElements }}</span>
        </div>
        <div v-if="operationStore.loading" class="p-4 text-sm text-muted-foreground">
          {{ t('common.loading') }}
        </div>
        <div v-else-if="operationStore.operations.length === 0" data-testid="settings-audit-empty" class="p-8 text-center text-sm text-muted-foreground">
          {{ t('settings.auditEmpty') }}
        </div>
        <ul v-else class="divide-y divide-border">
          <li v-for="operation in operationStore.operations" :key="operation.id">
            <button
              type="button"
              class="w-full px-4 py-3 text-left transition-colors hover:bg-muted/50"
              :class="selectedOperationId === operation.id ? 'bg-muted/60' : ''"
              :data-testid="`settings-audit-operation-${operation.id}`"
              @click="selectOperation(operation.id)"
            >
              <div class="flex items-start justify-between gap-3">
                <span class="min-w-0 truncate text-sm font-medium">{{ operation.summary || operation.kind }}</span>
                <span class="shrink-0 text-xs font-medium" :class="statusClass(operation.status)">
                  {{ operation.status }}
                </span>
              </div>
              <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{{ operation.kind }}</span>
                <span>{{ operation.source }}</span>
                <span>{{ formatTime(operation.createdAt) }}</span>
              </div>
            </button>
          </li>
        </ul>
        <footer class="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <button type="button" :disabled="operationStore.page === 0" class="rounded px-2 py-1 hover:bg-muted disabled:opacity-40" @click="changePage(-1)">
            {{ t('settings.auditPrevious') }}
          </button>
          <span>{{ operationStore.page + 1 }} / {{ Math.max(operationStore.totalPages, 1) }}</span>
          <button type="button" :disabled="operationStore.page + 1 >= operationStore.totalPages" class="rounded px-2 py-1 hover:bg-muted disabled:opacity-40" @click="changePage(1)">
            {{ t('settings.auditNext') }}
          </button>
        </footer>
      </section>

      <section class="min-w-0 rounded-lg border border-border bg-card">
        <div class="border-b border-border px-4 py-3">
          <h2 class="text-sm font-medium">{{ t('settings.auditTrace') }}</h2>
        </div>
        <div v-if="operationStore.traceLoading" class="p-4 text-sm text-muted-foreground">{{ t('common.loading') }}</div>
        <div v-else-if="!selectedTrace" data-testid="settings-audit-no-selection" class="p-8 text-center text-sm text-muted-foreground">
          {{ t('settings.auditSelectOperation') }}
        </div>
        <div v-else class="space-y-5 p-4">
          <div class="grid grid-cols-2 gap-3 text-sm">
            <div><dt class="text-xs text-muted-foreground">{{ t('settings.auditStatus') }}</dt><dd class="mt-1 font-medium" :class="statusClass(selectedTrace.operation.status)">{{ selectedTrace.operation.status }}</dd></div>
            <div><dt class="text-xs text-muted-foreground">{{ t('settings.auditStarted') }}</dt><dd class="mt-1">{{ formatTime(selectedTrace.operation.startedAt) }}</dd></div>
            <div><dt class="text-xs text-muted-foreground">{{ t('settings.auditKind') }}</dt><dd class="mt-1">{{ selectedTrace.operation.kind }}</dd></div>
            <div class="col-span-2"><dt class="text-xs text-muted-foreground">{{ t('settings.auditRun') }}</dt><dd class="mt-1 break-all font-mono text-xs" :title="selectedTrace.operation.runId || ''">{{ selectedTrace.operation.runId || t('settings.auditNotAvailable') }}</dd></div>
          </div>

          <div>
            <h3 class="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{{ t('settings.auditItems') }}</h3>
            <div v-if="selectedTrace.items.length === 0" class="text-sm text-muted-foreground">{{ t('settings.auditNoItems') }}</div>
            <ul v-else class="space-y-2">
              <li v-for="item in selectedTrace.items" :key="item.id" class="rounded-md border border-border/70 px-3 py-2">
                <div class="flex items-center justify-between gap-3 text-sm">
                  <span>{{ item.toolName || item.kind }}</span>
                  <span :class="statusClass(item.status)">{{ item.status }}</span>
                </div>
                <div class="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>{{ item.source }}</span>
                  <span v-if="item.approvalRequestId">{{ t('settings.auditApprovalLinked') }}</span>
                  <span v-if="item.errorCode">{{ item.errorCode }}</span>
                </div>
              </li>
            </ul>
          </div>

          <div>
            <h3 class="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{{ t('settings.auditAttempts') }}</h3>
            <ul class="space-y-2">
              <li v-for="attempt in selectedTrace.attempts" :key="attempt.id" class="flex items-center justify-between gap-3 border-l-2 border-border pl-3 text-sm">
                <span><span class="font-medium">{{ attempt.stage }}</span> <span class="text-xs text-muted-foreground">{{ attempt.module }} #{{ attempt.retryNo }}</span></span>
                <span class="shrink-0 text-xs" :class="statusClass(attempt.status)">{{ attempt.status }} · {{ formatDuration(attempt.durationMs) }}</span>
              </li>
            </ul>
          </div>

          <div data-testid="settings-audit-events">
            <h3 class="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">{{ t('settings.auditEvents') }}</h3>
            <div v-if="selectedTrace.events.length === 0" class="text-sm text-muted-foreground">{{ t('settings.auditNoEvents') }}</div>
            <ul v-else class="space-y-2">
              <li v-for="event in selectedTrace.events" :key="event.id" class="flex items-center justify-between gap-3 border-l-2 border-border pl-3 text-sm">
                <span class="font-mono text-xs">{{ event.eventType }}</span>
                <span class="shrink-0 text-xs text-muted-foreground">{{ event.state }} · {{ event.actor }}</span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  </main>
</template>
