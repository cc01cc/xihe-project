<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert, Repeat2 } from '@lucide/vue'
import BackToChatButton from '../../components/settings/BackToChatButton.vue'
import SettingsNav from '../../components/settings/SettingsNav.vue'
import { useOperationStore } from '../../stores/operations'
import type {
  ApprovalPolicyEffect,
  ApprovalPolicyMode,
  ApprovalPolicyShape,
  ApprovalPolicySourceLayer,
  OperationItemView,
  OperationStatus,
} from '../../types'

const { t } = useI18n()
const operationStore = useOperationStore()
const statusFilter = ref<OperationStatus | ''>('')
const selectedOperationId = ref<string | null>(null)

const selectedTrace = computed(() => operationStore.selectedTrace)

const sourceLayerLabels: Record<ApprovalPolicySourceLayer, string> = {
  builtin: 'chat.approvalLayerBuiltin',
  instance: 'chat.approvalLayerInstance',
  user: 'chat.approvalLayerUser',
  workspace: 'chat.approvalLayerWorkspace',
  session: 'chat.approvalLayerSession',
  per_call: 'chat.approvalLayerPerCall',
}

const modeLabels: Record<Exclude<ApprovalPolicyMode, null>, string> = {
  manual: 'chat.approvalModeManual',
  auto: 'chat.approvalModeAuto',
}

const shapeLabels: Record<ApprovalPolicyShape, string> = {
  structured: 'chat.approvalShapeStructured',
  interpreter: 'chat.approvalShapeInterpreter',
  opaque: 'chat.approvalShapeOpaque',
}

const effectLabels: Record<ApprovalPolicyEffect, string> = {
  allow: 'settings.policyEffectAllow',
  ask: 'settings.policyEffectAsk',
  deny: 'settings.policyEffectDeny',
}

function effectClass(effect: ApprovalPolicyEffect): string {
  if (effect === 'deny') return 'border-destructive/40 bg-destructive/10 text-destructive'
  if (effect === 'ask') return 'border-amber-500/40 bg-amber-500/10 text-foreground'
  return 'border-emerald-500/40 bg-emerald-500/10 text-foreground'
}

function layerLabel(layer: ApprovalPolicySourceLayer): string {
  return t(sourceLayerLabels[layer])
}

function modeLabel(mode: ApprovalPolicyMode): string {
  return mode === null ? t('chat.approvalModeUnavailable') : t(modeLabels[mode])
}

function allowedByLabel(allowedBy: string): string {
  if (allowedBy.startsWith('auto')) return t('settings.auditPolicyAllowedByAuto')
  return t('settings.auditPolicyAllowedByOther')
}

function policyTestId(item: OperationItemView): string {
  return `settings-audit-policy-${item.toolCallId || item.id}`
}

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
            <ul v-else data-testid="settings-audit-items" class="space-y-2">
              <li
                v-for="item in selectedTrace.items"
                :key="item.id"
                :data-testid="`settings-audit-item-${item.id}`"
                class="rounded-md border border-border/70 px-3 py-2"
              >
                <div class="flex items-center justify-between gap-3 text-sm">
                  <span>{{ item.toolName || item.kind }}</span>
                  <span :class="statusClass(item.status)">{{ item.status }}</span>
                </div>
                <div class="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>{{ item.source }}</span>
                  <span v-if="item.approvalRequestId">{{ t('settings.auditApprovalLinked') }}</span>
                  <span v-if="item.errorCode">{{ item.errorCode }}</span>
                </div>

                <div
                  v-if="item.policy"
                  :data-testid="policyTestId(item)"
                  class="mt-2 rounded-md border border-border/70 bg-muted/30 px-2.5 py-2 text-xs"
                >
                  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span class="font-medium">{{ t('settings.auditPolicy') }}</span>
                    <span
                      :data-testid="`${policyTestId(item)}-effect`"
                      class="rounded-full border px-2 py-0.5 font-medium"
                      :class="effectClass(item.policy.effect)"
                    >
                      {{ t(effectLabels[item.policy.effect]) }}
                    </span>
                    <span
                      v-if="item.policy.reused === true"
                      :data-testid="`${policyTestId(item)}-reused`"
                      class="inline-flex items-center gap-1 rounded-full border border-sky-600/50 bg-sky-500/15 px-2 py-0.5 font-medium"
                    >
                      <Repeat2 class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {{ t('settings.auditPolicyReused') }}
                    </span>
                    <span v-if="item.toolCallId" class="font-mono text-muted-foreground" :title="item.toolCallId">
                      {{ t('settings.auditPolicyToolCallId') }}: {{ item.toolCallId }}
                    </span>
                  </div>
                  <dl class="mt-1.5 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                    <div class="flex min-w-0 gap-1.5">
                      <dt class="shrink-0 text-muted-foreground">{{ t('chat.approvalEvidenceMatchedRule') }}</dt>
                      <dd :data-testid="`${policyTestId(item)}-matched-rule`" class="min-w-0 break-all font-mono">
                        {{ item.policy.matchedRule ?? t('chat.approvalNoMatchedRule') }}
                      </dd>
                    </div>
                    <div class="flex min-w-0 gap-1.5">
                      <dt class="shrink-0 text-muted-foreground">{{ t('chat.approvalEvidenceSourceLayer') }}</dt>
                      <dd :data-testid="`${policyTestId(item)}-source-layer`">{{ layerLabel(item.policy.sourceLayer) }}</dd>
                    </div>
                    <div class="flex min-w-0 gap-1.5">
                      <dt class="shrink-0 text-muted-foreground">{{ t('chat.approvalEvidenceMode') }}</dt>
                      <dd :data-testid="`${policyTestId(item)}-mode`">{{ modeLabel(item.policy.mode) }}</dd>
                    </div>
                  </dl>
                  <p
                    v-if="item.policy.allowedBy"
                    :data-testid="`${policyTestId(item)}-allowed-by`"
                    class="mt-1.5 flex flex-wrap items-center gap-x-1.5 rounded border border-amber-600/50 bg-amber-500/15 px-2 py-1 font-medium"
                  >
                    <TriangleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>{{ allowedByLabel(item.policy.allowedBy) }}</span>
                    <code class="font-mono">{{ item.policy.allowedBy }}</code>
                  </p>
                  <details class="mt-1.5">
                    <summary class="cursor-pointer text-muted-foreground hover:text-foreground">{{ t('settings.auditPolicyDetail') }}</summary>
                    <dl class="mt-1 space-y-1">
                      <div class="flex min-w-0 gap-1.5">
                        <dt class="shrink-0 text-muted-foreground">{{ t('chat.approvalEvidenceReason') }}</dt>
                        <dd :data-testid="`${policyTestId(item)}-reason`" class="min-w-0 whitespace-pre-wrap break-words">{{ item.policy.reason }}</dd>
                      </div>
                      <div class="flex min-w-0 gap-1.5">
                        <dt class="shrink-0 text-muted-foreground">{{ t('chat.approvalEvidenceActionClass') }}</dt>
                        <dd :data-testid="`${policyTestId(item)}-action-class`" class="min-w-0 break-all font-mono">{{ item.policy.actionClass }}</dd>
                      </div>
                      <div class="flex min-w-0 gap-1.5">
                        <dt class="shrink-0 text-muted-foreground">{{ t('chat.approvalEvidenceShape') }}</dt>
                        <dd :data-testid="`${policyTestId(item)}-shape`">{{ t(shapeLabels[item.policy.shape]) }}</dd>
                      </div>
                    </dl>
                  </details>
                </div>
                <p
                  v-else
                  :data-testid="`settings-audit-policy-absent-${item.id}`"
                  class="mt-2 text-xs text-muted-foreground"
                >
                  {{ t('settings.auditPolicyAbsent') }}
                </p>
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
