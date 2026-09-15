<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { ChevronDown, LoaderCircle, Lock, RefreshCw, TriangleAlert } from '@lucide/vue'
import BackToChatButton from '../../components/settings/BackToChatButton.vue'
import SettingsNav from '../../components/settings/SettingsNav.vue'
import BaseModal from '../../components/shared/BaseModal.vue'
import { ApiError } from '../../composables/api'
import { useAuthStore } from '../../stores/auth'
import { usePolicyAdminStore, type PolicyRuleDraft } from '../../stores/policyAdmin'
import type { ApprovalPolicyEffect, PolicyRuleLayer, PolicyRuleView } from '../../types'

const { t } = useI18n()
const authStore = useAuthStore()
const policyAdmin = usePolicyAdminStore()

const BUILTIN_ACTION_CLASSES = ['read', 'write', 'delete', 'exec', 'network', 'credential'] as const

const layerOptions = computed<PolicyRuleLayer[]>(() => authStore.isAdmin
  ? ['instance', 'user', 'workspace']
  : ['user', 'workspace'])
const activeLayer = ref<PolicyRuleLayer>(authStore.isAdmin ? 'instance' : 'user')

const rules = computed(() => policyAdmin.rulesByLayer[activeLayer.value])
const rulesLoading = computed(() => policyAdmin.rulesLoading[activeLayer.value])
const rulesError = computed(() => policyAdmin.rulesError[activeLayer.value])
const rulesForbidden = computed(() => policyAdmin.rulesForbidden[activeLayer.value])
const conflicts = computed(() => policyAdmin.conflictsByLayer[activeLayer.value])
const conflictsError = computed(() => policyAdmin.conflictsError[activeLayer.value])

const expandedDomains = ref<Set<string>>(new Set())
const deleteTarget = ref<PolicyRuleView | null>(null)

const createActionClass = ref('')
const createResource = ref('')
const createEffect = ref<ApprovalPolicyEffect>('allow')
const createPriority = ref(0)
const createLocked = ref(false)
const createValidation = ref<string | null>(null)
const createError = ref<string | null>(null)

const actionClassSuggestions = computed(() => {
  const classes = new Set<string>(BUILTIN_ACTION_CLASSES)
  policyAdmin.domains.forEach((domain) => classes.add(domain.actionClass))
  return [...classes].sort()
})
const canSubmitCreate = computed(() => createActionClass.value.trim().length > 0
  && createResource.value.trim().length > 0
  && !policyAdmin.creatingRule)

const layerLabels: Record<PolicyRuleLayer, string> = {
  instance: 'chat.approvalLayerInstance',
  user: 'chat.approvalLayerUser',
  workspace: 'chat.approvalLayerWorkspace',
}
const sourceLayerLabels: Record<string, string> = {
  builtin: 'chat.approvalLayerBuiltin',
  instance: 'chat.approvalLayerInstance',
  user: 'chat.approvalLayerUser',
  workspace: 'chat.approvalLayerWorkspace',
}
const effectLabels: Record<ApprovalPolicyEffect, string> = {
  allow: 'settings.policyEffectAllow',
  ask: 'settings.policyEffectAsk',
  deny: 'settings.policyEffectDeny',
}

function layerLabel(layer: string): string {
  return sourceLayerLabels[layer] ? t(sourceLayerLabels[layer]) : layer
}

function effectClass(effect: ApprovalPolicyEffect): string {
  if (effect === 'deny') return 'border-destructive/40 bg-destructive/10 text-destructive'
  if (effect === 'ask') return 'border-amber-500/40 bg-amber-500/10 text-foreground'
  return 'border-emerald-500/40 bg-emerald-500/10 text-foreground'
}

function toggleDomain(actionClass: string) {
  const next = new Set(expandedDomains.value)
  if (next.has(actionClass)) next.delete(actionClass)
  else next.add(actionClass)
  expandedDomains.value = next
}

function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
  return cause instanceof Error ? cause.message : fallback
}

function forbiddenHint(layer: PolicyRuleLayer): string {
  return layer === 'instance'
    ? t('settings.policyForbiddenInstance')
    : t('settings.policyForbiddenWorkspace')
}

async function selectLayer(layer: PolicyRuleLayer) {
  activeLayer.value = layer
  createValidation.value = null
  createError.value = null
  if (!policyAdmin.rulesLoading[layer] && policyAdmin.rulesByLayer[layer].length === 0 && !policyAdmin.rulesError[layer]) {
    await Promise.all([policyAdmin.loadRules(layer), policyAdmin.loadConflicts(layer)])
  }
}

async function refresh() {
  await Promise.all([
    policyAdmin.loadRules(activeLayer.value),
    policyAdmin.loadConflicts(activeLayer.value),
    policyAdmin.loadDomains(),
  ])
}

async function submitCreate() {
  const actionClass = createActionClass.value.trim()
  const resource = createResource.value.trim()
  if (!actionClass || !resource) {
    createValidation.value = t('settings.policyCreateValidation')
    return
  }
  createValidation.value = null
  createError.value = null
  const draft: PolicyRuleDraft = {
    layer: activeLayer.value,
    actionClass,
    resource,
    effect: createEffect.value,
    priority: Number.isFinite(createPriority.value) ? createPriority.value : 0,
    locked: authStore.isAdmin && createLocked.value,
  }
  try {
    await policyAdmin.createRule(draft)
    toast.success(t('settings.policyCreated'))
    createActionClass.value = ''
    createResource.value = ''
    createLocked.value = false
  } catch (cause) {
    createError.value = errorText(cause, t('settings.policyCreateFailed'))
    toast.error(t('settings.policyCreateFailed'))
  }
}

function requestDelete(rule: PolicyRuleView) {
  deleteTarget.value = rule
}

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target) return
  try {
    await policyAdmin.deleteRule(target.id, activeLayer.value)
    toast.success(t('settings.policyDeleted'))
  } catch {
    toast.error(t('settings.policyDeleteFailed'))
  } finally {
    deleteTarget.value = null
  }
}

onMounted(() => {
  void policyAdmin.loadDomains()
  void policyAdmin.loadRules(activeLayer.value)
  void policyAdmin.loadConflicts(activeLayer.value)
})
</script>

<template>
  <BackToChatButton />
  <SettingsNav />
  <main class="mx-auto max-w-5xl px-4 py-6">
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="mb-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">XH / Policy</p>
        <h1 data-testid="settings-policy-heading" class="text-xl font-semibold tracking-tight">
          {{ t('settings.policyTitle') }}
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.policyDesc') }}</p>
      </div>
      <button
        type="button"
        data-testid="settings-policy-refresh"
        class="inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        :disabled="rulesLoading"
        @click="refresh"
      >
        <RefreshCw class="size-4" :class="rulesLoading ? 'animate-spin' : ''" aria-hidden="true" />
        {{ t('settings.policyRefresh') }}
      </button>
    </header>

    <section class="mb-6 rounded-lg border border-border bg-card" aria-labelledby="policy-domains-heading">
      <div class="border-b border-border px-4 py-3">
        <h2 id="policy-domains-heading" class="text-sm font-medium">{{ t('settings.policyDomains') }}</h2>
      </div>
      <p v-if="policyAdmin.domainsLoading" class="p-4 text-sm text-muted-foreground">{{ t('common.loading') }}</p>
      <p v-else-if="policyAdmin.domainsError" data-testid="settings-policy-domains-error" class="p-4 text-sm text-destructive" role="alert">
        {{ policyAdmin.domainsError }}
      </p>
      <p v-else-if="policyAdmin.domains.length === 0" class="p-4 text-sm text-muted-foreground">
        {{ t('settings.policyDomainsEmpty') }}
      </p>
      <ul v-else data-testid="settings-policy-domains" class="divide-y divide-border">
        <li v-for="domain in policyAdmin.domains" :key="domain.actionClass" class="px-4 py-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="font-mono text-sm">{{ domain.actionClass }}</span>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <span
                :data-testid="`settings-policy-domain-effective-${domain.actionClass}`"
                class="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5"
              >
                {{ t('settings.policyDomainEffective') }}: {{ layerLabel(domain.effectiveLayer) }}
              </span>
              <button
                type="button"
                :data-testid="`settings-policy-domain-toggle-${domain.actionClass}`"
                class="inline-flex min-h-8 items-center gap-1 rounded-md border px-2 py-1 transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :aria-expanded="expandedDomains.has(domain.actionClass)"
                @click="toggleDomain(domain.actionClass)"
              >
                <ChevronDown
                  class="size-3.5 transition-transform"
                  :class="expandedDomains.has(domain.actionClass) ? 'rotate-180' : ''"
                  aria-hidden="true"
                />
                {{ expandedDomains.has(domain.actionClass) ? t('settings.policyDomainToggleClose') : t('settings.policyDomainToggle') }}
              </button>
            </div>
          </div>
          <dl
            v-if="expandedDomains.has(domain.actionClass)"
            :data-testid="`settings-policy-domain-detail-${domain.actionClass}`"
            class="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2"
          >
            <div v-for="layer in layerOptions" :key="layer" class="flex items-center justify-between gap-3">
              <dt class="text-muted-foreground">{{ t(layerLabels[layer]) }}</dt>
              <dd class="tabular-nums">
                {{ domain.ruleCounts[layer] ?? 0 }} {{ t('settings.policyDomainRuleCount') }}
              </dd>
            </div>
          </dl>
        </li>
      </ul>
    </section>

    <section class="rounded-lg border border-border bg-card" aria-labelledby="policy-rules-heading">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 id="policy-rules-heading" class="text-sm font-medium">{{ t('settings.policyLayer') }}</h2>
        <div class="flex flex-wrap gap-1" role="group" :aria-label="t('settings.policyLayer')">
          <button
            v-for="layer in layerOptions"
            :key="layer"
            type="button"
            :data-testid="`settings-policy-layer-${layer}`"
            class="min-h-9 rounded-md border px-3 py-1.5 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="activeLayer === layer ? 'border-primary bg-primary/10 font-medium' : 'border-transparent hover:bg-accent'"
            :aria-pressed="activeLayer === layer"
            @click="selectLayer(layer)"
          >
            {{ t(layerLabels[layer]) }}
          </button>
        </div>
      </div>

      <div v-if="rulesForbidden" data-testid="settings-policy-forbidden" class="m-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="status">
        {{ forbiddenHint(activeLayer) }}
      </div>
      <p v-if="rulesError" data-testid="settings-policy-error" class="px-4 pt-3 text-sm text-destructive" role="alert">
        {{ rulesError }}
      </p>
      <p v-if="createError" data-testid="settings-policy-create-error" class="px-4 pt-3 text-sm text-destructive" role="alert">
        {{ createError }}
      </p>

      <div class="border-b border-border px-4 py-3">
        <h3 class="mb-2 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {{ t('settings.policyConflictSummary') }}
        </h3>
        <div v-if="conflicts.length > 0" data-testid="settings-policy-conflict-summary" class="text-sm">
          <p class="flex items-start gap-2 text-amber-600 dark:text-amber-400">
            <TriangleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{{ t('settings.policyConflictFound') }}</span>
          </p>
          <ul class="mt-1 space-y-0.5 text-xs text-muted-foreground">
            <li v-for="rule in conflicts" :key="`conflict-${rule.id}`" class="font-mono break-all">
              {{ rule.actionClass }} · {{ rule.resource }} — {{ rule.conflict }}
            </li>
          </ul>
        </div>
        <p v-else-if="conflictsError" data-testid="settings-policy-conflict-unavailable" class="text-sm text-muted-foreground">
          {{ t('settings.policyConflictUnavailable') }}
        </p>
        <p v-else data-testid="settings-policy-conflict-none" class="text-sm text-muted-foreground">
          {{ t('settings.policyConflictNone') }}
        </p>
      </div>

      <div v-if="rulesLoading" class="p-4 text-sm text-muted-foreground">{{ t('common.loading') }}</div>
      <p v-else-if="rules.length === 0" data-testid="settings-policy-empty" class="p-8 text-center text-sm text-muted-foreground">
        {{ t('settings.policyRulesEmpty') }}
      </p>
      <ul v-else data-testid="settings-policy-rules" class="divide-y divide-border">
        <li v-for="rule in rules" :key="rule.id" :data-testid="`settings-policy-rule-${rule.id}`" class="px-4 py-3">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <span
                  :data-testid="`settings-policy-rule-effect-${rule.id}`"
                  class="rounded-full border px-2 py-0.5 text-xs"
                  :class="effectClass(rule.effect)"
                >
                  {{ t(effectLabels[rule.effect]) }}
                </span>
                <span class="font-mono text-sm break-all">{{ rule.actionClass }}</span>
                <span
                  v-if="rule.locked"
                  :data-testid="`settings-policy-rule-locked-${rule.id}`"
                  class="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
                  :title="t('settings.policyLockedReason')"
                >
                  <Lock class="size-3" aria-hidden="true" />
                  {{ t('settings.policyLockedBadge') }}
                </span>
              </div>
              <p class="font-mono text-xs text-muted-foreground break-all">
                {{ rule.resource }}
              </p>
              <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span :data-testid="`settings-policy-rule-priority-${rule.id}`">
                  {{ t('settings.policyCreatePriority') }}: {{ rule.priority }}
                </span>
                <span
                  v-if="rule.effective"
                  :data-testid="`settings-policy-rule-effective-${rule.id}`"
                  class="text-emerald-600 dark:text-emerald-400"
                >
                  {{ t('settings.policyEffective') }}
                </span>
                <span v-else :data-testid="`settings-policy-rule-not-effective-${rule.id}`">
                  {{ t('settings.policyNotEffective') }}
                </span>
                <span v-if="rule.locked" class="inline-flex items-center gap-1">
                  <Lock class="size-3" aria-hidden="true" />
                  {{ t('settings.policyLockedReason') }}
                </span>
              </div>
              <p
                v-if="rule.conflict"
                :data-testid="`settings-policy-rule-conflict-${rule.id}`"
                class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
                role="status"
              >
                <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>
                  <span class="font-medium">{{ t('settings.policyConflictBadge') }}:</span>
                  {{ rule.conflict }}
                </span>
              </p>
            </div>
            <button
              type="button"
              :data-testid="`settings-policy-rule-delete-${rule.id}`"
              class="inline-flex min-h-10 items-center justify-center rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="policyAdmin.deletingRuleId === rule.id"
              @click="requestDelete(rule)"
            >
              {{ t('settings.policyDelete') }}
            </button>
          </div>
        </li>
      </ul>

      <form
        data-testid="settings-policy-create"
        class="space-y-3 border-t border-border px-4 py-4"
        @submit.prevent="submitCreate"
      >
        <h3 class="text-sm font-medium">{{ t('settings.policyCreateTitle') }}</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <label for="policy-create-action-class" class="text-sm font-medium">{{ t('settings.policyCreateActionClass') }}</label>
            <input
              id="policy-create-action-class"
              v-model="createActionClass"
              data-testid="settings-policy-create-action-class"
              type="text"
              list="policy-action-class-suggestions"
              autocomplete="off"
              maxlength="64"
              class="w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              :disabled="policyAdmin.creatingRule"
            />
            <datalist id="policy-action-class-suggestions">
              <option v-for="item in actionClassSuggestions" :key="item" :value="item" />
            </datalist>
          </div>
          <div class="space-y-1.5">
            <label for="policy-create-resource" class="text-sm font-medium">{{ t('settings.policyCreateResource') }}</label>
            <input
              id="policy-create-resource"
              v-model="createResource"
              data-testid="settings-policy-create-resource"
              type="text"
              maxlength="512"
              class="w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              :disabled="policyAdmin.creatingRule"
            />
            <p class="text-xs text-muted-foreground">{{ t('settings.policyCreateResourceHint') }}</p>
          </div>
          <div class="space-y-1.5">
            <label for="policy-create-effect" class="text-sm font-medium">{{ t('settings.policyCreateEffect') }}</label>
            <select
              id="policy-create-effect"
              v-model="createEffect"
              data-testid="settings-policy-create-effect"
              class="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              :disabled="policyAdmin.creatingRule"
            >
              <option value="allow">{{ t('settings.policyEffectAllow') }}</option>
              <option value="ask">{{ t('settings.policyEffectAsk') }}</option>
              <option value="deny">{{ t('settings.policyEffectDeny') }}</option>
            </select>
          </div>
          <div class="space-y-1.5">
            <label for="policy-create-priority" class="text-sm font-medium">{{ t('settings.policyCreatePriority') }}</label>
            <input
              id="policy-create-priority"
              v-model.number="createPriority"
              data-testid="settings-policy-create-priority"
              type="number"
              step="1"
              min="0"
              class="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              :disabled="policyAdmin.creatingRule"
            />
          </div>
        </div>
        <label v-if="authStore.isAdmin" class="flex items-start gap-2 text-sm">
          <input
            v-model="createLocked"
            data-testid="settings-policy-create-locked"
            type="checkbox"
            class="mt-0.5 size-4 rounded border"
            :disabled="policyAdmin.creatingRule || createEffect === 'allow'"
          />
          <span>
            {{ t('settings.policyCreateLocked') }}
            <span class="block text-xs text-muted-foreground">{{ t('settings.policyLockedReason') }}</span>
          </span>
        </label>
        <p v-if="createValidation" data-testid="settings-policy-create-validation" class="text-sm text-destructive" role="alert">
          {{ createValidation }}
        </p>
        <div class="flex justify-end">
          <button
            type="submit"
            data-testid="settings-policy-create-submit"
            class="inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canSubmitCreate"
          >
            <LoaderCircle v-if="policyAdmin.creatingRule" class="mr-1.5 size-4 animate-spin" aria-hidden="true" />
            {{ policyAdmin.creatingRule ? t('settings.policyCreating') : t('settings.policyCreateSubmit') }}
          </button>
        </div>
      </form>
    </section>
  </main>

  <BaseModal :show="deleteTarget !== null" :title="t('settings.policyDeleteTitle')" @close="deleteTarget = null">
    <p class="mb-4 text-sm text-muted-foreground">{{ t('settings.policyDeleteConfirm') }}</p>
    <p v-if="deleteTarget" class="mb-4 rounded-lg border bg-muted/30 p-3 font-mono text-xs break-all">
      {{ deleteTarget.actionClass }} · {{ deleteTarget.resource }}
    </p>
    <div class="flex justify-end gap-2 border-t pt-3">
      <button
        type="button"
        data-testid="settings-policy-delete-cancel"
        class="inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @click="deleteTarget = null"
      >
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        data-testid="settings-policy-delete-confirm"
        class="inline-flex min-h-10 items-center justify-center rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="policyAdmin.deletingRuleId !== null"
        @click="confirmDelete"
      >
        {{ t('settings.policyDeleteConfirmAction') }}
      </button>
    </div>
  </BaseModal>
</template>
