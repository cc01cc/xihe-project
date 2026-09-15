<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '../shared/BaseModal.vue'
import type { ApprovalDecision, ApprovalPolicyMode, ApprovalPolicyShape, ApprovalPolicySourceLayer, ApprovalRequest } from '../../types'
import { Bot, LoaderCircle } from '@lucide/vue'

const props = withDefaults(defineProps<{
  approval: ApprovalRequest | null
  show: boolean
  busy?: boolean
  error?: string | null
}>(), {
  busy: false,
  error: null,
})

const emit = defineEmits<{
  approve: [decision: ApprovalDecision]
  reject: [decision: ApprovalDecision]
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

const shapeWarning = computed(() => {
  const shape = props.approval?.policy?.shape
  if (shape === 'interpreter') return t('chat.approvalShapeInterpreterWarning')
  if (shape === 'opaque') return t('chat.approvalShapeOpaqueWarning')
  return ''
})

const canSubmit = computed(() => Boolean(props.approval) && !props.busy && !submitted.value)
const isStructuredPolicy = computed(() => props.approval?.policy?.shape === 'structured')
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
  saveConfirming.value = false
  savedLayer.value = 'workspace'
  resource.value = ''
  wildcardConfirmed.value = false
  feedback.value = ''
  submitted.value = false
  saveValidationError.value = null
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
  if (!canSubmit.value) return
  submitted.value = true
  emit('approve', { decision })
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
  if (!canSubmitSaved.value) {
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
  })
}

function submitReject() {
  if (!canSubmitReject.value) return
  submitted.value = true
  const trimmedFeedback = normalizedFeedback.value
  emit('reject', trimmedFeedback
    ? { decision: 'reject', feedback: trimmedFeedback.slice(0, maxDecisionTextLength) }
    : { decision: 'reject' })
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
  }
  // The once button is the default focus. This also supports keyboard users
  // whose focus is on the modal surface rather than on a control.
  if (event.key === 'Enter' && event.target === event.currentTarget && !saveConfirming.value) {
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
                <dd data-testid="approval-evidence-shape">{{ t(shapeLabels[approval.policy.shape]) }}</dd>
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

        <template v-if="!saveConfirming">
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
              data-testid="approval-allow-session"
              type="button"
              class="inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!canSubmit"
              @click="submitAllow('session')"
            >
              {{ t('chat.approvalAllowSession') }}
            </button>
            <button
              v-if="isStructuredPolicy"
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
