<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { LoaderCircle, Lock, RefreshCw, TriangleAlert, Wrench } from '@lucide/vue'
import BackToChatButton from '../../components/settings/BackToChatButton.vue'
import SettingsNav from '../../components/settings/SettingsNav.vue'
import { ApiError } from '../../composables/api'
import { useAuthStore } from '../../stores/auth'
import { usePolicyAdminStore } from '../../stores/policyAdmin'
import type { ApprovalPolicyShape, PolicyToolFaceQueryScope, PolicyToolFaceView } from '../../types'

const { t } = useI18n()
const authStore = useAuthStore()
const policyAdmin = usePolicyAdminStore()

const BUILTIN_ACTION_CLASSES = ['read', 'write', 'delete', 'exec', 'network', 'credential'] as const
const UNCLASSIFIED = 'unclassified'

const scopeOptions = computed<PolicyToolFaceQueryScope[]>(() => authStore.isAdmin
  ? ['workspace', 'instance']
  : ['workspace'])
const activeScope = ref<PolicyToolFaceQueryScope>('workspace')

const classifyTarget = ref<PolicyToolFaceView | null>(null)
const classifyActionClass = ref('')
const classifyShape = ref<ApprovalPolicyShape>('opaque')
const classifyValidation = ref<string | null>(null)

const scopeLabels: Record<PolicyToolFaceQueryScope, string> = {
  workspace: 'settings.toolFacesScopeWorkspace',
  instance: 'settings.toolFacesScopeInstance',
}
const sourceLabels: Record<string, string> = {
  builtin: 'settings.toolFacesSourceBuiltin',
  instance: 'settings.toolFacesSourceInstance',
  workspace: 'settings.toolFacesSourceWorkspace',
}
const shapeLabels: Record<ApprovalPolicyShape, string> = {
  structured: 'chat.approvalShapeStructured',
  interpreter: 'chat.approvalShapeInterpreter',
  opaque: 'chat.approvalShapeOpaque',
}

const canClassify = computed(() => activeScope.value === 'instance'
  ? authStore.isAdmin
  : authStore.canClassifyTools)
const actionClassSuggestions = computed(() => [...new Set<string>(BUILTIN_ACTION_CLASSES)].sort())

function isUnclassified(face: PolicyToolFaceView): boolean {
  return face.actionClass === UNCLASSIFIED
}

function canOpenClassifyForm(face: PolicyToolFaceView): boolean {
  // Only unclassified tools need classification. Built-in faces can never be
  // overridden at workspace scope (server-enforced) and this view does not offer
  // re-classifying an already classified face.
  return canClassify.value && isUnclassified(face)
}

function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
  return cause instanceof Error ? cause.message : fallback
}

async function selectScope(scope: PolicyToolFaceQueryScope) {
  activeScope.value = scope
  classifyTarget.value = null
  classifyValidation.value = null
  await policyAdmin.loadToolFaces(scope)
}

function openClassify(face: PolicyToolFaceView) {
  classifyTarget.value = face
  classifyValidation.value = null
  classifyActionClass.value = isUnclassified(face) ? '' : face.actionClass
  classifyShape.value = face.shape
}

function closeClassify() {
  classifyTarget.value = null
  classifyValidation.value = null
}

async function submitClassify() {
  const target = classifyTarget.value
  if (!target) return
  const actionClass = classifyActionClass.value.trim()
  if (!actionClass) {
    classifyValidation.value = t('settings.toolFacesClassifyRequired')
    return
  }
  classifyValidation.value = null
  try {
    await policyAdmin.classifyTool({
      scope: activeScope.value,
      tool: target.tool,
      actionClass,
      shape: classifyShape.value,
    })
    toast.success(t('settings.toolFacesClassified'))
    closeClassify()
  } catch (cause) {
    toast.error(t('settings.toolFacesClassifyFailed'))
    classifyValidation.value = errorText(cause, t('settings.toolFacesClassifyFailed'))
  }
}

onMounted(() => {
  void policyAdmin.loadToolFaces(activeScope.value)
})
</script>

<template>
  <BackToChatButton />
  <SettingsNav />
  <main class="mx-auto max-w-5xl px-4 py-6">
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p class="mb-1 text-xs uppercase tracking-[0.18em] text-muted-foreground">XH / Policy</p>
        <h1 data-testid="settings-tool-faces-heading" class="text-xl font-semibold tracking-tight">
          {{ t('settings.toolFacesTitle') }}
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('settings.toolFacesDesc') }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex flex-wrap gap-1" role="group" :aria-label="t('settings.toolFacesScope')">
          <button
            v-for="scope in scopeOptions"
            :key="scope"
            type="button"
            :data-testid="`settings-tool-faces-scope-${scope}`"
            class="min-h-10 rounded-lg border px-3 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            :class="activeScope === scope ? 'border-primary bg-primary/10 font-medium' : 'border-transparent hover:bg-accent'"
            :aria-pressed="activeScope === scope"
            @click="selectScope(scope)"
          >
            {{ t(scopeLabels[scope]) }}
          </button>
        </div>
        <button
          type="button"
          data-testid="settings-tool-faces-refresh"
          class="inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :disabled="policyAdmin.toolFacesLoading"
          @click="policyAdmin.loadToolFaces(activeScope)"
        >
          <RefreshCw class="size-4" :class="policyAdmin.toolFacesLoading ? 'animate-spin' : ''" aria-hidden="true" />
          {{ t('settings.policyRefresh') }}
        </button>
      </div>
    </header>

    <p data-testid="settings-tool-faces-note" class="mb-4 rounded-lg border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
      {{ t('settings.toolFacesUnclassifiedNote') }}
    </p>

    <div v-if="!canClassify" data-testid="settings-tool-faces-forbidden" class="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm" role="status">
      {{ t('settings.toolFacesForbidden') }}
    </div>
    <p v-if="policyAdmin.toolFacesError" data-testid="settings-tool-faces-error" class="mb-4 text-sm text-destructive" role="alert">
      {{ policyAdmin.toolFacesError }}
    </p>

    <section class="rounded-lg border border-border bg-card" aria-labelledby="tool-faces-heading">
      <div class="border-b border-border px-4 py-3">
        <h2 id="tool-faces-heading" class="text-sm font-medium">{{ t('settings.toolFacesTitle') }}</h2>
      </div>
      <p v-if="policyAdmin.toolFacesLoading" class="p-4 text-sm text-muted-foreground">{{ t('common.loading') }}</p>
      <p v-else-if="policyAdmin.toolFaces.length === 0" data-testid="settings-tool-faces-empty" class="p-8 text-center text-sm text-muted-foreground">
        {{ t('settings.toolFacesEmpty') }}
      </p>
      <ul v-else data-testid="settings-tool-faces-list" class="divide-y divide-border">
        <li
          v-for="face in policyAdmin.toolFaces"
          :key="`${face.scope}-${face.tool}`"
          :data-testid="`settings-tool-face-${face.tool}`"
          class="px-4 py-3"
          :class="isUnclassified(face) ? 'border-l-4 border-l-amber-500 bg-amber-500/5' : ''"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <Wrench class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="font-mono text-sm break-all">{{ face.tool }}</span>
                <span
                  :data-testid="`settings-tool-face-source-${face.tool}`"
                  class="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs"
                >
                  {{ t(sourceLabels[face.scope] ?? face.scope) }}
                </span>
                <span
                  v-if="face.id === null"
                  class="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
                  :title="t('settings.toolFacesBuiltinProtected')"
                >
                  <Lock class="size-3" aria-hidden="true" />
                  {{ t('settings.toolFacesSourceBuiltin') }}
                </span>
              </div>
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span :data-testid="`settings-tool-face-action-class-${face.tool}`">
                  {{ t('settings.toolFacesActionClass') }}: <span class="font-mono">{{ face.actionClass }}</span>
                </span>
                <span :data-testid="`settings-tool-face-shape-${face.tool}`">
                  {{ t('settings.toolFacesShape') }}: {{ t(shapeLabels[face.shape]) }}
                </span>
              </div>
              <p
                v-if="isUnclassified(face)"
                :data-testid="`settings-tool-face-unclassified-${face.tool}`"
                class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs"
                role="status"
              >
                <TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{{ t('settings.toolFacesUnclassified') }}</span>
              </p>
            </div>
            <button
              v-if="canOpenClassifyForm(face)"
              type="button"
              :data-testid="`settings-tool-face-classify-${face.tool}`"
              class="inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              @click="openClassify(face)"
            >
              {{ t('settings.toolFacesClassify') }}
            </button>
          </div>

          <form
            v-if="classifyTarget?.tool === face.tool"
            :data-testid="`settings-tool-face-classify-form-${face.tool}`"
            class="mt-3 space-y-3 rounded-lg border border-border bg-muted/20 p-3"
            @submit.prevent="submitClassify"
          >
            <h3 class="text-sm font-medium">{{ t('settings.toolFacesClassifyTitle') }}</h3>
            <div class="grid gap-3 sm:grid-cols-2">
              <div class="space-y-1.5">
                <label :for="`tool-face-action-class-${face.tool}`" class="text-sm font-medium">
                  {{ t('settings.toolFacesActionClass') }}
                </label>
                <input
                  :id="`tool-face-action-class-${face.tool}`"
                  v-model="classifyActionClass"
                  :data-testid="`settings-tool-face-classify-action-class-${face.tool}`"
                  type="text"
                  list="tool-face-action-class-suggestions"
                  autocomplete="off"
                  maxlength="64"
                  class="w-full rounded-lg border bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  :disabled="policyAdmin.classifyingTool"
                />
              </div>
              <div class="space-y-1.5">
                <label :for="`tool-face-shape-${face.tool}`" class="text-sm font-medium">
                  {{ t('settings.toolFacesShape') }}
                </label>
                <select
                  :id="`tool-face-shape-${face.tool}`"
                  v-model="classifyShape"
                  :data-testid="`settings-tool-face-classify-shape-${face.tool}`"
                  class="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  :disabled="policyAdmin.classifyingTool"
                >
                  <option value="structured">{{ t('chat.approvalShapeStructured') }}</option>
                  <option value="interpreter">{{ t('chat.approvalShapeInterpreter') }}</option>
                  <option value="opaque">{{ t('chat.approvalShapeOpaque') }}</option>
                </select>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">{{ t('settings.toolFacesForbidden') }}</p>
            <p
              v-if="classifyValidation"
              :data-testid="`settings-tool-face-classify-validation-${face.tool}`"
              class="text-sm text-destructive"
              role="alert"
            >
              {{ classifyValidation }}
            </p>
            <div class="flex flex-wrap justify-end gap-2">
              <button
                type="button"
                :data-testid="`settings-tool-face-classify-cancel-${face.tool}`"
                class="inline-flex min-h-10 items-center justify-center rounded-lg border px-3 py-2 text-sm font-medium transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :disabled="policyAdmin.classifyingTool"
                @click="closeClassify"
              >
                {{ t('settings.toolFacesClassifyCancel') }}
              </button>
              <button
                type="submit"
                :data-testid="`settings-tool-face-classify-submit-${face.tool}`"
                class="inline-flex min-h-10 items-center justify-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="policyAdmin.classifyingTool"
              >
                <LoaderCircle v-if="policyAdmin.classifyingTool" class="mr-1.5 size-4 animate-spin" aria-hidden="true" />
                {{ t('settings.toolFacesClassifySubmit') }}
              </button>
            </div>
          </form>
        </li>
      </ul>
      <datalist id="tool-face-action-class-suggestions">
        <option v-for="item in actionClassSuggestions" :key="item" :value="item" />
      </datalist>
    </section>
  </main>
</template>
