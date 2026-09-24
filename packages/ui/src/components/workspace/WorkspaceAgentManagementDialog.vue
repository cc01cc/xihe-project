<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BaseModal from '../shared/BaseModal.vue'
import {
  ApiError,
  api,
  type AgentPrincipalCreateResponse,
  type WorkspaceAgentBinding,
  type WorkspaceAgentPermission,
} from '../../composables/api'

const props = defineProps<{
  open: boolean
  workspaceId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const { t } = useI18n()
const actionClasses = ['read', 'write', 'delete', 'exec', 'network', 'credential'] as const
const agents = ref<WorkspaceAgentBinding[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const status = ref('')
const name = ref('')
const createdPrincipal = ref<AgentPrincipalCreateResponse | null>(null)
const permissions = ref<WorkspaceAgentPermission[]>([])
const editingPrincipalId = ref<string | null>(null)
const unbindConfirmationId = ref<string | null>(null)

watch(() => props.open, (open) => {
  if (open) void loadAgents()
})

async function loadAgents() {
  loading.value = true
  error.value = ''
  status.value = ''
  try {
    agents.value = await api.getWorkspaceAgents(props.workspaceId)
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : t('workspace.agentLoadFailed')
  } finally {
    loading.value = false
  }
}

function actionLabel(actionClass: string): string {
  const key = `workspace.agentAction${actionClass[0]?.toUpperCase()}${actionClass.slice(1)}`
  const label = t(key)
  return label === key ? actionClass : label
}

function hasPermission(actionClass: string): boolean {
  return permissions.value.some((permission) => permission.actionClass === actionClass)
}

function permissionResource(actionClass: string): string {
  return permissions.value.find((permission) => permission.actionClass === actionClass)?.resource ?? '*'
}

function togglePermission(actionClass: string, checked: boolean) {
  const current = permissions.value.filter((permission) => permission.actionClass !== actionClass)
  if (checked) current.push({ actionClass, resource: '*' })
  permissions.value = current
}

function setPermissionResource(actionClass: string, resource: string) {
  permissions.value = permissions.value.map((permission) => permission.actionClass === actionClass
    ? { ...permission, resource: resource.trim() || '*' }
    : permission)
}

async function createPrincipal() {
  if (!name.value.trim() || saving.value) return
  saving.value = true
  error.value = ''
  try {
    createdPrincipal.value = await api.createAgentPrincipal(name.value.trim())
    name.value = ''
    permissions.value = []
    status.value = t('workspace.agentPrincipalCreated')
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : t('workspace.agentCreateFailed')
  } finally {
    saving.value = false
  }
}

async function bindCreatedPrincipal() {
  const principal = createdPrincipal.value
  if (!principal || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await api.updateWorkspaceAgentCap(props.workspaceId, principal.principalId, permissions.value)
    createdPrincipal.value = null
    permissions.value = []
    await loadAgents()
    status.value = t('workspace.agentBound')
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : t('workspace.agentBindFailed')
  } finally {
    saving.value = false
  }
}

function startEditing(agent: WorkspaceAgentBinding) {
  editingPrincipalId.value = agent.principalId
  permissions.value = agent.permissions.map((permission) => ({ ...permission }))
  error.value = ''
}

async function saveCap(agent: WorkspaceAgentBinding) {
  if (saving.value) return
  saving.value = true
  error.value = ''
  try {
    await api.updateWorkspaceAgentCap(props.workspaceId, agent.principalId, permissions.value)
    editingPrincipalId.value = null
    await loadAgents()
    status.value = t('workspace.agentCapSaved')
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : t('workspace.agentSaveFailed')
  } finally {
    saving.value = false
  }
}

async function unbind(agent: WorkspaceAgentBinding) {
  if (unbindConfirmationId.value !== agent.principalId || saving.value) {
    unbindConfirmationId.value = agent.principalId
    return
  }
  saving.value = true
  error.value = ''
  try {
    await api.deleteWorkspaceAgent(props.workspaceId, agent.principalId)
    unbindConfirmationId.value = null
    await loadAgents()
    status.value = t('workspace.agentUnboundSuccess')
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : t('workspace.agentUnbindFailed')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <BaseModal :show="open" :title="t('workspace.agentManagement')" @close="emit('close')">
    <div class="max-h-[72vh] space-y-5 overflow-y-auto pr-1" data-testid="workspace-agent-management-dialog">
      <p class="text-sm text-muted-foreground">{{ t('workspace.agentManagementDescription') }}</p>

      <form class="space-y-3 rounded-lg border p-3" data-testid="agent-principal-create-form"
            @submit.prevent="createPrincipal">
        <div>
          <h3 class="text-sm font-semibold">{{ t('workspace.createAgentPrincipal') }}</h3>
          <p class="mt-1 text-xs text-muted-foreground">{{ t('workspace.agentCreatePermissionNote') }}</p>
        </div>
        <label class="block space-y-1 text-sm">
          <span>{{ t('workspace.agentName') }}</span>
          <input v-model="name" required maxlength="120" data-testid="agent-principal-name"
                 class="w-full rounded-md border bg-background px-3 py-2" />
        </label>
        <button type="submit" data-testid="agent-principal-create"
                class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                :disabled="!name.trim() || saving">
          {{ t('workspace.createAgentPrincipal') }}
        </button>
      </form>

      <section v-if="createdPrincipal" class="space-y-3 rounded-lg border border-amber-500/40 p-3"
               data-testid="unbound-agent-principal">
        <div>
          <h3 class="text-sm font-semibold">{{ t('workspace.agentCreatedUnbound') }}</h3>
          <p class="mt-1 break-all font-mono text-xs text-muted-foreground">{{ createdPrincipal.principalId }}</p>
        </div>
        <p class="text-xs text-muted-foreground">{{ t('workspace.agentCapNote') }}</p>
        <div class="space-y-2">
          <div v-for="actionClass in actionClasses" :key="actionClass" class="grid grid-cols-[1fr_1fr] items-center gap-2">
            <label class="flex items-center gap-2 text-sm">
              <input type="checkbox" :checked="hasPermission(actionClass)"
                     :data-testid="`agent-cap-${actionClass}`"
                     @change="togglePermission(actionClass, ($event.target as HTMLInputElement).checked)" />
              {{ actionLabel(actionClass) }}
            </label>
            <input v-if="hasPermission(actionClass)" :value="permissionResource(actionClass)"
                   :data-testid="`agent-resource-${actionClass}`"
                   :aria-label="t('workspace.agentResourceFor', { action: actionLabel(actionClass) })"
                   class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                   @input="setPermissionResource(actionClass, ($event.target as HTMLInputElement).value)" />
          </div>
        </div>
        <button type="button" data-testid="agent-principal-bind"
                class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                :disabled="saving" @click="bindCreatedPrincipal">
          {{ t('workspace.bindAgent') }}
        </button>
      </section>

      <section class="space-y-3" aria-labelledby="workspace-agent-list-title">
        <div class="flex items-center justify-between">
          <h3 id="workspace-agent-list-title" class="text-sm font-semibold">{{ t('workspace.boundAgents') }}</h3>
          <button type="button" data-testid="workspace-agent-refresh"
                  class="text-xs text-muted-foreground underline" :disabled="loading"
                  @click="loadAgents">{{ t('workspace.refreshAgents') }}</button>
        </div>
        <p v-if="loading" class="text-sm text-muted-foreground" role="status">{{ t('workspace.loadingAgents') }}</p>
        <p v-else-if="agents.length === 0" class="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {{ t('workspace.noBoundAgent') }}
        </p>
        <article v-for="agent in agents" :key="agent.principalId"
                 class="space-y-3 rounded-lg border p-3" :data-testid="`workspace-agent-${agent.principalId}`">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h4 class="truncate text-sm font-semibold">{{ agent.name }}</h4>
              <p class="mt-1 break-all font-mono text-[11px] text-muted-foreground">{{ agent.principalId }}</p>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ agent.templateName ?? t('workspace.defaultAgentTemplate') }} ·
                {{ t('workspace.agentTemplateId') }}: {{ agent.templateId ?? '—' }} ·
                {{ t('workspace.agentWorkspaceId') }}: {{ workspaceId }} ·
                {{ new Date(agent.createdAt).toLocaleString() }}
              </p>
            </div>
            <button type="button" class="shrink-0 rounded-md border px-2 py-1 text-xs"
                    :data-testid="`workspace-agent-unbind-${agent.principalId}`"
                    @click="unbind(agent)">
              {{ unbindConfirmationId === agent.principalId ? t('workspace.confirmAgentUnbind') : t('workspace.unbindAgent') }}
            </button>
          </div>
          <div v-if="editingPrincipalId !== agent.principalId" class="flex flex-wrap gap-1.5" data-testid="workspace-agent-cap">
            <span v-for="permission in agent.permissions" :key="`${permission.actionClass}:${permission.resource ?? '*'}`"
                  class="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {{ actionLabel(permission.actionClass) }} · {{ permission.resource ?? '*' }}
            </span>
            <span v-if="agent.permissions.length === 0" class="text-xs text-muted-foreground">
              {{ t('workspace.noAgentCapabilities') }}
            </span>
            <button type="button" class="ml-auto text-xs underline"
                    :data-testid="`workspace-agent-edit-cap-${agent.principalId}`"
                    @click="startEditing(agent)">
              {{ t('workspace.editAgentCap') }}
            </button>
          </div>
          <div v-else class="space-y-2 border-t pt-3">
            <div v-for="actionClass in actionClasses" :key="actionClass" class="grid grid-cols-[1fr_1fr] items-center gap-2">
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" :checked="hasPermission(actionClass)"
                       :data-testid="`agent-cap-${actionClass}`"
                       @change="togglePermission(actionClass, ($event.target as HTMLInputElement).checked)" />
                {{ actionLabel(actionClass) }}
              </label>
              <input v-if="hasPermission(actionClass)" :value="permissionResource(actionClass)"
                     :data-testid="`agent-resource-${actionClass}`"
                     :aria-label="t('workspace.agentResourceFor', { action: actionLabel(actionClass) })"
                     class="min-w-0 rounded-md border bg-background px-2 py-1 text-xs"
                     @input="setPermissionResource(actionClass, ($event.target as HTMLInputElement).value)" />
            </div>
            <div class="flex justify-end gap-2">
              <button type="button" class="rounded-md border px-2 py-1 text-xs"
                      @click="editingPrincipalId = null">{{ t('workspace.cancel') }}</button>
              <button type="button" :data-testid="`workspace-agent-save-cap-${agent.principalId}`"
                      class="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
                      :disabled="saving" @click="saveCap(agent)">{{ t('workspace.saveAgentCap') }}</button>
            </div>
          </div>
        </article>
      </section>

      <p v-if="error" role="alert" class="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
        {{ error }}
      </p>
      <p v-if="status" role="status" class="text-sm text-emerald-700 dark:text-emerald-300">
        {{ status }}
      </p>
    </div>
  </BaseModal>
</template>
