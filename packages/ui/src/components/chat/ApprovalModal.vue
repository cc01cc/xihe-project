<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '../shared/BaseModal.vue'
import { ApiError, api } from '../../composables/api'
import { logger } from '../../lib/logger'
import type { ApprovalDecisionEnvelope, ApprovalPolicyMode, ApprovalPolicyShape, ApprovalPolicySourceLayer, ApprovalRequest } from '../../types'
import { Bot, LoaderCircle, ShieldCheck } from '@lucide/vue'

const props = withDefaults(defineProps<{
  approval: ApprovalRequest | null
  show: boolean
  busy?: boolean
  error?: string | null
  /** Workspace OWNER / instance ADMIN only; the server still rejects unauthorized writes. */
  canClassify?: boolean
}>(), {
  busy: false,
  error: null,
  canClassify: false,
})

const emit = defineEmits<{
  approve: [decision: ApprovalDecisionEnvelope]
  reject: [decision: ApprovalDecisionEnvelope]
}>()

const { t } = useI18n()

const saveConfirming = ref(false)
const savedLayer = ref<'workspace' | 'user'>('workspace')
const resource = ref('')
const wildcardConfirmed = ref(false)
const feedback = ref('')
const submitted = ref(false)
const saveValidationError = ref<string | null>(null)
const onceButton = ref<HTMLButtonElement | null>(null)
const sessionButton = ref<HTMLButtonElement | null>(null)
const saveButton = ref<HTMLButtonElement | null>(null)
const saveConfirmButton = ref<HTMLButtonElement | null>(null)
const approvalContent = ref<HTMLDivElement | null>(null)
let previouslyFocused: HTMLElement | null = null
const maxDecisionTextLength = 512

// Classification workflow (PLAN-0328 T1.14 / spec/ui-ux §3.4): unclassified tools may only be
// allowed once, and only after an explicit classification. Never auto-approve.
const classifyConfirming = ref(false)
const classifyActionClass = ref('')
const classifyShape = ref<ApprovalPolicyShape>('opaque')
const classifySubmitting = ref(false)
const classifyError = ref<string | null>(null)
// Monotonic token for the classify step: reset/cancel/request-change bumps it so a write that
// resolves later can never emit a decision for a request (or form state) that no longer applies.
let classifyGeneration = 0
const classifyEntryButton = ref<HTMLButtonElement | null>(null)
const classifyInput = ref<HTMLInputElement | null>(null)
const classifyActionClassSuggestions = ['read', 'write', 'delete', 'exec', 'network', 'credential']

const sourceLayerLabels: Record<ApprovalPolicySourceLayer, string> = {
  builtin: 'chat.approvalLayerBuiltin',
  instance: 'chat.approvalLayerInstance',
  user: 'chat.approvalLayerUser',
  workspace: 'chat.approvalLayerWorkspace',
  session: 'chat.approvalLayerSession',
  per_call: 'chat.approvalLayerPerCall',
}

const modeLabels: Record<Exclude<ApprovalPolicyMode, null>, string> = {
  default: 'chat.approvalModeDefault',
  bypass: 'chat.approvalModeBypass',
  managed: 'chat.approvalModeManaged',
  'accept-edits': 'chat.approvalModeAcceptEdits',
  plan: 'chat.approvalModePlan',
}

const shapeLabels: Record<ApprovalPolicyShape, string> = {
  structured: 'chat.approvalShapeStructured',
  interpreter: 'chat.approvalShapeInterpreter',
  opaque: 'chat.approvalShapeOpaque',
}

/** Shape label that tolerates values outside the contract instead of failing the i18n lookup. */
const shapeLabel = computed(() => {
  const shape = props.approval?.policy?.shape
  if (!shape) return ''
  const labelKey = (shapeLabels as Record<string, string | undefined>)[shape]
  return labelKey ? t(labelKey) : shape
})

const shapeWarning = computed(() => {
  const shape = props.approval?.policy?.shape
  if (shape === 'interpreter') return t('chat.approvalShapeInterpreterWarning')
  if (shape === 'opaque') return t('chat.approvalShapeOpaqueWarning')
  return ''
})

const canSubmit = computed(() => Boolean(props.approval) && !props.busy && !submitted.value)
const isStructuredPolicy = computed(() => props.approval?.policy?.shape === 'structured')
/** O-face: the tool has no registered action class, so reuse rules cannot be granted. */
const isUnclassifiedPolicy = computed(() => props.approval?.policy?.actionClass === 'unclassified')
const policyShape = computed(() => props.approval?.policy?.shape)
/** Delete action class is the one structured domain the server caps at `once`. */
const isDeleteActionClass = computed(() => props.approval?.policy?.actionClass === 'delete')
/**
 * Decision tiers the server accepts for this tool shape (CP ReusePolicy.allowedTiers):
 * structured → once/session/saved; structured+delete and opaque/unclassified → once only;
 * interpreter → once/session. Offering a tier outside the ceiling would only produce a
 * 400 REUSE_NOT_ALLOWED_FOR_SHAPE, so the buttons mirror the contract exactly. When the
 * `policy` projection is absent (legacy payload) or carries a shape outside the contract,
 * there is no shape evidence to derive a ceiling from, so the UI fails closed to `once`
 * only and explains the missing evidence instead of offering a tier the server would reject.
 */
const hasKnownShape = computed(() => policyShape.value === 'structured'
  || policyShape.value === 'interpreter'
  || policyShape.value === 'opaque')
const canOfferSessionTier = computed(() => {
  if (!props.approval || !hasKnownShape.value || isUnclassifiedPolicy.value) return false
  if (policyShape.value === 'opaque') return false
  if (policyShape.value === 'structured') return !isDeleteActionClass.value
  return true
})
const canOfferSavedTier = computed(() => policyShape.value === 'structured'
  && !isDeleteActionClass.value
  && !isUnclassifiedPolicy.value)
/** Inline explanation shown when a tier is unavailable for the current shape. */
const tierGateReason = computed(() => {
  if (!props.approval || isUnclassifiedPolicy.value) return ''
  // No shape evidence: only the once tier is derivable, never a reuse or saved tier.
  if (!hasKnownShape.value) return t('chat.approvalTierGateShapeUnavailable')
  if (policyShape.value === 'interpreter') return t('chat.approvalTierGateInterpreter')
  if (policyShape.value === 'opaque') return t('chat.approvalTierGateOpaque')
  if (policyShape.value === 'structured' && isDeleteActionClass.value) return t('chat.approvalTierGateDelete')
  return ''
})
const showClassifyEntry = computed(() => isUnclassifiedPolicy.value && props.canClassify)
const canSubmitClassify = computed(() => Boolean(props.approval)
  && !props.busy
  && !submitted.value
  && !classifySubmitting.value
  && classifyActionClass.value.trim().length > 0)
const modeAtGrant = computed(() => props.approval?.modeAtGrant !== undefined
  ? props.approval.modeAtGrant
  : props.approval?.policy?.modeAtGrant)
const normalizedResource = computed(() => resource.value.trim())
const normalizedFeedback = computed(() => feedback.value.trim())
const feedbackTooLong = computed(() => normalizedFeedback.value.length > maxDecisionTextLength)
const resourceTooLong = computed(() => normalizedResource.value.length > maxDecisionTextLength)
const savedRuleValidationMessage = computed(() => {
  if (!normalizedResource.value) return t('chat.approvalRuleResourceRequired')
  if (resourceTooLong.value) return t('chat.approvalRuleResourceTooLong')
  if (normalizedResource.value === '*' && !wildcardConfirmed.value) {
    return t('chat.approvalRuleWildcardConfirmationRequired')
  }
  return ''
})
const canSubmitSaved = computed(() => canSubmit.value && isStructuredPolicy.value && !savedRuleValidationMessage.value)
const canSubmitReject = computed(() => canSubmit.value && !feedbackTooLong.value)

function resetForm() {
  classifyGeneration += 1
  saveConfirming.value = false
  savedLayer.value = 'workspace'
  resource.value = ''
  wildcardConfirmed.value = false
  feedback.value = ''
  submitted.value = false
  saveValidationError.value = null
  classifyConfirming.value = false
  classifyActionClass.value = ''
  classifyShape.value = 'opaque'
  classifySubmitting.value = false
  classifyError.value = null
}

function focusMainAction() {
  void nextTick(() => {
    if (onceButton.value) {
      onceButton.value.focus()
    } else if (sessionButton.value) {
      sessionButton.value.focus()
    } else {
      saveButton.value?.focus()
    }
  })
}

function restoreFocus() {
  const target = previouslyFocused
  previouslyFocused = null
  if (target && document.body.contains(target) && !target.hasAttribute('disabled')) {
    target.focus()
  }
}

watch(() => props.show, async (show, wasShown) => {
  if (show) {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    resetForm()
    await nextTick()
    focusMainAction()
  } else if (wasShown) {
    await nextTick()
    restoreFocus()
  }
}, { immediate: true })

watch(() => props.approval?.requestId, (requestId, previousRequestId) => {
  if (props.show && requestId && requestId !== previousRequestId) {
    resetForm()
    focusMainAction()
  }
})

watch(() => props.error, (error) => {
  if (error) submitted.value = false
})

watch([resource, wildcardConfirmed], () => {
  saveValidationError.value = null
})

function submitAllow(decision: 'once' | 'session') {
  const approval = props.approval
  if (!approval || !canSubmit.value) return
  submitted.value = true
  emit('approve', { decision, requestId: approval.requestId })
}

function openSaveConfirmation() {
  if (!canSubmit.value || !isStructuredPolicy.value) return
  saveConfirming.value = true
  void nextTick(() => saveConfirmButton.value?.focus())
}

function cancelSaveConfirmation() {
  saveConfirming.value = false
  saveValidationError.value = null
  void nextTick(() => saveButton.value?.focus())
}

function submitSaved() {
  const approval = props.approval
  if (!approval || !canSubmitSaved.value) {
    saveValidationError.value = savedRuleValidationMessage.value || null
    return
  }
  submitted.value = true
  emit('approve', {
    decision: 'saved',
    layer: savedLayer.value,
    // The server derives actionClass from the tool registry. The UI only
    // narrows the resource selected by the user.
    rule: { resource: normalizedResource.value },
    requestId: approval.requestId,
  })
}

function submitReject() {
  const approval = props.approval
  if (!approval || !canSubmitReject.value) return
  submitted.value = true
  const trimmedFeedback = normalizedFeedback.value
  emit('reject', trimmedFeedback
    ? { decision: 'reject', feedback: trimmedFeedback.slice(0, maxDecisionTextLength), requestId: approval.requestId }
    : { decision: 'reject', requestId: approval.requestId })
}

function openClassifyConfirmation() {
  if (!canSubmit.value || !showClassifyEntry.value) return
  classifyConfirming.value = true
  classifyError.value = null
  classifyActionClass.value = ''
  classifyShape.value = 'opaque'
  void nextTick(() => classifyInput.value?.focus())
}

function cancelClassifyConfirmation() {
  // Escape/back invalidates any in-flight write and releases the submit guard so a cancelled
  // classification can never leave the step (or the next request) stuck busy.
  classifyGeneration += 1
  classifyConfirming.value = false
  classifySubmitting.value = false
  classifyError.value = null
  void nextTick(() => classifyEntryButton.value?.focus())
}

async function submitClassification() {
  const approval = props.approval
  if (!approval || !canSubmitClassify.value) return
  const requestId = approval.requestId
  const generation = ++classifyGeneration
  classifySubmitting.value = true
  classifyError.value = null
  try {
    // Explicit classification is persisted first; only then the original decision is emitted,
    // and it is always a one-shot `once`. The server enforces OWNER/ADMIN and may return 403.
    await api.upsertPolicyToolFace({
      scope: 'workspace',
      tool: approval.tool,
      actionClass: classifyActionClass.value.trim(),
      shape: classifyShape.value,
    })
    // The write may resolve after the request changed, the modal was reset, or Escape cancelled
    // the step: abort the continuation instead of emitting a decision for a different request.
    if (classifyGeneration !== generation || props.approval?.requestId !== requestId) return
    submitted.value = true
    emit('approve', { decision: 'once', requestId })
  } catch (cause) {
    if (classifyGeneration !== generation) {
      logger.warn('Discarded a stale failed tool classification', cause)
      return
    }
    classifyError.value = cause instanceof ApiError
      ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
      : t('chat.approvalClassifyFailed')
    logger.warn('Failed to classify tool before approval', cause)
  } finally {
    if (classifyGeneration === generation) classifySubmitting.value = false
  }
}

function handleClose() {
  if (saveConfirming.value && !canSubmit.value) return
  submitReject()
}

function handleContentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && saveConfirming.value) {
    event.preventDefault()
    event.stopPropagation()
    cancelSaveConfirmation()
    return
  }
  if (event.key === 'Escape' && classifyConfirming.value) {
    event.preventDefault()
    event.stopPropagation()
    cancelClassifyConfirmation()
    return
  }
  // The once button is the default focus. This also supports keyboard users
  // whose focus is on the modal surface rather than on a control.
  if (event.key === 'Enter' && event.target === event.currentTarget && !saveConfirming.value && !classifyConfirming.value) {
    event.preventDefault()
    submitAllow('once')
  }
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  ))
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (!props.show || event.key !== 'Tab') return
  const owner = approvalContent.value
  const active = document.activeElement
  const content = owner?.closest<HTMLElement>('[data-testid="modal-content"]')
  if (!content || !(active instanceof HTMLElement) || !content.contains(active)) return
  const focusable = getFocusableElements(content)
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

onMounted(() => document.addEventListener('keydown', handleDocumentKeydown, true))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleDocumentKeydown, true)
  restoreFocus()
})
</script>

<template>
  <BaseModal :show="show" :title="t('chat.approvalRequired')" @close="handleClose">
    <div ref="approvalContent" class="approval-content" @keydown="handleContentKeydown">
      <template v-if="approval">
        <p class="mb-4 text-sm text-muted-foreground">
          {{ t('chat.approvalDescription') }}
        </p>
        <p
          v-if="approval.state === 'dispatch_unknown'"
          data-testid="approval-retry-warning"
          class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          role="alert"
        >
          Recovery retry required: the previous approval dispatch did not report a result. Choose a decision to retry it; no decision is sent automatically.
        </p>

        <section class="mb-4 space-y-3" :aria-labelledby="`approval-tool-${approval.requestId}`">
          <div class="flex items-center gap-2 text-sm">
            <Bot class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span :id="`approval-tool-${approval.requestId}`" data-testid="approval-tool" class="font-medium">{{ approval.tool }}</span>
          </div>
          <div>
            <p class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('chat.approvalAction') }}</p>
            <p data-testid="approval-action" class="text-sm whitespace-pre-wrap">{{ approval.action }}</p>
          </div>
          <div>
            <p class="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{{ t('chat.approvalDetails') }}</p>
            <pre data-testid="approval-details" class="max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/50 p-3 text-xs font-mono">{{ approval.details }}</pre>
          </div>
        </section>

        <section data-testid="approval-evidence-section" class="mb-4 rounded-lg border bg-muted/20 p-3">
          <h3 class="mb-2 text-sm font-semibold">{{ t('chat.approvalEvidence') }}</h3>
          <div v-if="approval.policy || modeAtGrant !== undefined" data-testid="approval-evidence" class="space-y-2 text-xs">
            <dl class="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-2">
              <template v-if="approval.policy">
                <dt class="text-muted-foreground">{{ t('chat.approvalEvidenceActionClass') }}</dt>
                <dd data-testid="approval-evidence-action-class" class="break-all font-mono">{{ approval.policy.actionClass }}</dd>
                <dt class="text-muted-foreground">{{ t('chat.approvalEvidenceShape') }}</dt>
                <dd data-testid="approval-evidence-shape">{{ shapeLabel }}</dd>
                <dt class="text-muted-foreground">{{ t('chat.approvalEvidenceMatchedRule') }}</dt>
                <dd data-testid="approval-evidence-matched-rule" class="break-all font-mono">{{ approval.policy.matchedRule ?? t('chat.approvalNoMatchedRule') }}</dd>
                <dt class="text-muted-foreground">{{ t('chat.approvalEvidenceSourceLayer') }}</dt>
                <dd data-testid="approval-evidence-source-layer">{{ t(sourceLayerLabels[approval.policy.sourceLayer]) }}</dd>
                <dt class="text-muted-foreground">{{ t('chat.approvalEvidenceReason') }}</dt>
                <dd data-testid="approval-evidence-reason" class="whitespace-pre-wrap">{{ approval.policy.reason }}</dd>
                <dt class="text-muted-foreground">{{ t('chat.approvalEvidenceMode') }}</dt>
                <dd data-testid="approval-evidence-mode">
                  {{ approval.policy.mode === null ? t('chat.approvalModeUnavailable') : t(modeLabels[approval.policy.mode]) }}
                </dd>
              </template>
              <template v-if="modeAtGrant !== undefined">
                <dt class="text-muted-foreground">{{ t('chat.approvalEvidenceModeAtGrant') }}</dt>
                <dd data-testid="approval-evidence-mode-at-grant">
                  {{ modeAtGrant === null ? t('chat.approvalModeUnavailable') : t(modeLabels[modeAtGrant]) }}
                </dd>
              </template>
            </dl>
            <p v-if="shapeWarning" data-testid="approval-shape-warning" class="border-t border-border/70 pt-2 text-muted-foreground">
              {{ shapeWarning }}
            </p>
          </div>
          <p v-else data-testid="approval-evidence-unavailable" class="text-sm text-muted-foreground">
            {{ t('chat.approvalEvidenceUnavailable') }}
          </p>
        </section>

        <template v-if="!saveConfirming && !classifyConfirming">
          <p
            v-if="isUnclassifiedPolicy"
            data-testid="approval-unclassified-notice"
            class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
            role="status"
          >
            {{ t('chat.approvalUnclassifiedNotice') }}
          </p>

          <div class="mb-4 space-y-1.5">
            <label for="approval-feedback" class="text-sm font-medium">{{ t('chat.approvalRejectFeedbackLabel') }}</label>
            <p class="text-xs text-muted-foreground">{{ t('chat.approvalRejectFeedbackOptional') }}</p>
            <textarea
              id="approval-feedback"
              v-model="feedback"
              data-testid="approval-feedback"
              rows="3"
              class="w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              :placeholder="t('chat.approvalRejectFeedbackPlaceholder')"
              :disabled="busy || submitted"
              maxlength="512"
            />
            <p v-if="feedbackTooLong" data-testid="approval-feedback-validation" class="text-sm text-destructive" role="alert">
              {{ t('chat.approvalRejectFeedbackTooLong') }}
            </p>
          </div>

          <p v-if="error" id="approval-error" data-testid="approval-error" class="mb-3 text-sm text-destructive" role="alert">{{ error }}</p>
          <p v-if="tierGateReason" data-testid="approval-tier-gate-reason" class="mb-3 text-xs text-muted-foreground">
            {{ tierGateReason }}
          </p>

          <div class="flex flex-wrap justify-end gap-2 border-t pt-3">
            <button
              ref="onceButton"
              data-testid="approval-approve"
              type="button"
              class="order-first inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!canSubmit"
              @click="submitAllow('once')"
            >
              <LoaderCircle v-if="busy" class="mr-1.5 size-4 animate-spin" aria-hidden="true" />
              {{ busy ? t('common.saving') : t('chat.approvalAllowOnce') }}
            </button>
            <button
              ref="sessionButton"
              v-if="canOfferSessionTier"
              data-testid="approval-allow-session"
              type="button"
              class="inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!canSubmit"
              @click="submitAllow('session')"
            >
              {{ t('chat.approvalAllowSession') }}
            </button>
            <button
              v-if="canOfferSavedTier"
              ref="saveButton"
              data-testid="approval-save-rule"
              type="button"
              class="inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!canSubmit"
              @click="openSaveConfirmation"
            >
              {{ t('chat.approvalSaveRule') }}
            </button>
            <button
              v-if="showClassifyEntry"
              ref="classifyEntryButton"
              data-testid="approval-classify-entry"
              type="button"
              class="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 px-3 py-2 text-sm font-medium transition hover:bg-amber-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!canSubmit"
              @click="openClassifyConfirmation"
            >
              <ShieldCheck class="size-4" aria-hidden="true" />
              {{ t('chat.approvalClassifyAndAllow') }}
            </button>
            <button
              data-testid="approval-reject"
              type="button"
              class="inline-flex min-h-10 items-center justify-center rounded-lg border border-destructive/40 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!canSubmitReject"
              @click="submitReject"
            >
              {{ t('chat.reject') }}
            </button>
          </div>
        </template>

        <template v-else-if="classifyConfirming">
          <section data-testid="approval-classify-confirm" class="space-y-4">
            <div>
              <h3 class="text-base font-semibold">{{ t('chat.approvalClassifyTitle') }}</h3>
              <p class="mt-1 text-sm text-muted-foreground">{{ t('chat.approvalClassifyDescription') }}</p>
            </div>

            <div class="space-y-1.5">
              <label for="approval-classify-action-class" class="text-sm font-medium">
                {{ t('chat.approvalClassifyActionClass') }}
              </label>
              <input
                id="approval-classify-action-class"
                ref="classifyInput"
                v-model="classifyActionClass"
                data-testid="approval-classify-action-class"
                type="text"
                list="approval-classify-action-classes"
                autocomplete="off"
                maxlength="64"
                class="w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                :placeholder="t('chat.approvalClassifyActionClassPlaceholder')"
                :disabled="busy || submitted || classifySubmitting"
              />
              <datalist id="approval-classify-action-classes">
                <option v-for="item in classifyActionClassSuggestions" :key="item" :value="item" />
              </datalist>
              <p v-if="!classifyActionClass.trim()" class="text-xs text-muted-foreground">
                {{ t('chat.approvalClassifyActionClassRequired') }}
              </p>
            </div>

            <div class="space-y-1.5">
              <label for="approval-classify-shape" class="text-sm font-medium">{{ t('chat.approvalClassifyShape') }}</label>
              <select
                id="approval-classify-shape"
                v-model="classifyShape"
                data-testid="approval-classify-shape"
                class="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                :disabled="busy || submitted || classifySubmitting"
              >
                <option value="structured">{{ t('chat.approvalShapeStructured') }}</option>
                <option value="interpreter">{{ t('chat.approvalShapeInterpreter') }}</option>
                <option value="opaque">{{ t('chat.approvalShapeOpaque') }}</option>
              </select>
            </div>

            <p data-testid="approval-classify-authority" class="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
              {{ t('chat.approvalClassifyAuthorityHint') }}
            </p>
            <p data-testid="approval-classify-once-note" class="text-xs text-muted-foreground">
              {{ t('chat.approvalClassifyRequiresOnce') }}
            </p>

            <p v-if="classifyError" data-testid="approval-classify-error" class="text-sm text-destructive" role="alert">
              {{ classifyError }}
            </p>
            <p v-if="error" data-testid="approval-error" class="text-sm text-destructive" role="alert">{{ error }}</p>

            <div class="flex flex-wrap justify-end gap-2 border-t pt-3">
              <button
                type="button"
                data-testid="approval-classify-back"
                class="inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                :disabled="busy || classifySubmitting"
                @click="cancelClassifyConfirmation"
              >
                {{ t('chat.approvalClassifyBack') }}
              </button>
              <button
                type="button"
                data-testid="approval-classify-submit"
                class="inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="!canSubmitClassify"
                @click="submitClassification"
              >
                <LoaderCircle v-if="classifySubmitting" class="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                {{ t('chat.approvalClassifySubmit') }}
              </button>
            </div>
          </section>
        </template>

        <template v-else>
          <section data-testid="approval-save-confirm" class="space-y-4">
            <div>
              <h3 class="text-base font-semibold">{{ t('chat.approvalSaveRuleTitle') }}</h3>
              <p class="mt-1 text-sm text-muted-foreground">{{ t('chat.approvalSaveRuleDescription') }}</p>
            </div>

            <div class="space-y-1.5">
              <label for="approval-rule-layer" class="text-sm font-medium">{{ t('chat.approvalRuleLayer') }}</label>
              <select
                id="approval-rule-layer"
                v-model="savedLayer"
                data-testid="approval-rule-layer"
                class="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                :disabled="busy || submitted"
              >
                <option value="workspace">{{ t('chat.approvalLayerWorkspace') }}</option>
                <option value="user">{{ t('chat.approvalLayerUser') }}</option>
              </select>
            </div>

            <div class="space-y-1.5">
              <label for="approval-rule-resource" class="text-sm font-medium">{{ t('chat.approvalRuleResource') }}</label>
              <input
                id="approval-rule-resource"
                v-model="resource"
                data-testid="approval-rule-resource"
                type="text"
                class="w-full rounded-lg border bg-background px-3 py-2 text-sm font-mono outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                :disabled="busy || submitted"
                maxlength="512"
              />
            </div>

            <div data-testid="approval-rule-preview" class="rounded-lg border bg-muted/30 p-3 text-sm">
              <p class="mb-2 font-medium">{{ t('chat.approvalRulePreview') }}</p>
              <dl class="space-y-1 text-xs">
                <div class="flex justify-between gap-3">
                  <dt class="text-muted-foreground">{{ t('chat.approvalEvidenceActionClass') }}</dt>
                  <dd class="font-mono">{{ approval.policy?.actionClass ?? t('chat.approvalRuleActionClassDerived') }}</dd>
                </div>
                <div class="flex justify-between gap-3">
                  <dt class="text-muted-foreground">{{ t('chat.approvalRuleResource') }}</dt>
                  <dd class="break-all font-mono">{{ normalizedResource || t('chat.approvalRuleResourceUnset') }}</dd>
                </div>
                <div class="flex justify-between gap-3">
                  <dt class="text-muted-foreground">{{ t('chat.approvalRuleEffect') }}</dt>
                  <dd>{{ t('chat.approvalRuleAllow') }}</dd>
                </div>
              </dl>
            </div>

            <label v-if="normalizedResource === '*'" class="flex items-start gap-2 text-sm">
              <input
                v-model="wildcardConfirmed"
                data-testid="approval-rule-wildcard-confirm"
                type="checkbox"
                class="mt-0.5 size-4 rounded border"
                :disabled="busy || submitted"
              />
              <span>{{ t('chat.approvalRuleWildcardConfirmation') }}</span>
            </label>
            <p v-if="saveValidationError || savedRuleValidationMessage" data-testid="approval-rule-validation" class="text-sm text-destructive" role="alert">
              {{ saveValidationError || savedRuleValidationMessage }}
            </p>

            <p data-testid="approval-rule-warning" class="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-foreground">
              {{ t('chat.approvalPersistentWarning') }}
            </p>
            <p data-testid="approval-rule-preflight" class="text-xs text-muted-foreground">
              {{ t('chat.approvalPreflightUnavailable') }}
            </p>

            <p v-if="error" id="approval-error" data-testid="approval-error" class="text-sm text-destructive" role="alert">{{ error }}</p>

            <div class="flex flex-wrap justify-end gap-2 border-t pt-3">
              <button
                type="button"
                data-testid="approval-save-back"
                class="inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                :disabled="busy"
                @click="cancelSaveConfirmation"
              >
                {{ t('chat.approvalSaveBack') }}
              </button>
              <button
                ref="saveConfirmButton"
                type="button"
                data-testid="approval-save-confirm-button"
                class="inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="!canSubmitSaved"
                @click="submitSaved"
              >
                <LoaderCircle v-if="busy" class="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                {{ busy ? t('common.saving') : t('chat.approvalSaveConfirm') }}
              </button>
            </div>
          </section>
        </template>
      </template>
    </div>
  </BaseModal>
</template>

<style scoped>
@media (max-width: 640px) {
  .approval-content {
    max-height: calc(92vh - 4rem);
    max-height: calc(92dvh - 4rem);
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  :deep([data-testid="modal-backdrop"]) {
    align-items: flex-end;
  }

  :deep([data-testid="modal-content"]) {
    height: 92vh;
    height: 92dvh;
    max-height: 92dvh;
    max-width: none;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: 1rem 1rem 0 0;
    padding: 1rem;
  }
}
</style>
