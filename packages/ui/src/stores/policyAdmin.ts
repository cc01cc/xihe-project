import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ApiError, api } from '../composables/api'
import { logger } from '../lib/logger'
import type {
  ApprovalPolicyEffect,
  ApprovalPolicyShape,
  PolicyDomainView,
  PolicyRuleLayer,
  PolicyRuleView,
  PolicyToolFaceQueryScope,
  PolicyToolFaceView,
} from '../types'

export interface PolicyRuleDraft {
  layer: PolicyRuleLayer
  actionClass: string
  resource: string
  effect: ApprovalPolicyEffect
  priority: number
  locked: boolean
}

export interface ToolFaceClassificationDraft {
  scope: PolicyToolFaceQueryScope
  tool: string
  actionClass: string
  shape: ApprovalPolicyShape
}

function createLayerRecord<T>(create: () => T): Record<PolicyRuleLayer, T> {
  return { instance: create(), user: create(), workspace: create() }
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    return `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
  }
  return cause instanceof Error ? cause.message : fallback
}

/** 403 means the authenticated user lacks the layer's write authority (server is authoritative). */
function isForbidden(cause: unknown): boolean {
  return cause instanceof ApiError && cause.problem.status === 403
}

export const usePolicyAdminStore = defineStore('policyAdmin', () => {
  const domains = ref<PolicyDomainView[]>([])
  const domainsLoading = ref(false)
  const domainsError = ref<string | null>(null)

  const rulesByLayer = ref<Record<PolicyRuleLayer, PolicyRuleView[]>>(createLayerRecord(() => []))
  const rulesLoading = ref<Record<PolicyRuleLayer, boolean>>(createLayerRecord(() => false))
  const rulesError = ref<Record<PolicyRuleLayer, string | null>>(createLayerRecord(() => null))
  const rulesForbidden = ref<Record<PolicyRuleLayer, boolean>>(createLayerRecord(() => false))
  const conflictsByLayer = ref<Record<PolicyRuleLayer, PolicyRuleView[]>>(createLayerRecord(() => []))
  const conflictsError = ref<Record<PolicyRuleLayer, string | null>>(createLayerRecord(() => null))
  const creatingRule = ref(false)
  const deletingRuleId = ref<string | null>(null)

  const toolFaces = ref<PolicyToolFaceView[]>([])
  const toolFacesScope = ref<PolicyToolFaceQueryScope>('workspace')
  const toolFacesLoading = ref(false)
  const toolFacesError = ref<string | null>(null)
  const toolFacesForbidden = ref(false)
  const classifyingTool = ref(false)

  async function loadDomains(): Promise<void> {
    domainsLoading.value = true
    domainsError.value = null
    try {
      domains.value = await api.listPolicyDomains()
    } catch (cause) {
      domainsError.value = errorMessage(cause, 'Failed to load policy domains')
      logger.warn('Failed to load policy domains', cause)
    } finally {
      domainsLoading.value = false
    }
  }

  async function loadRules(layer: PolicyRuleLayer): Promise<void> {
    rulesLoading.value[layer] = true
    rulesError.value[layer] = null
    rulesForbidden.value[layer] = false
    try {
      rulesByLayer.value[layer] = await api.listPolicyRules(layer)
    } catch (cause) {
      rulesError.value[layer] = errorMessage(cause, 'Failed to load policy rules')
      rulesForbidden.value[layer] = isForbidden(cause)
      logger.warn(`Failed to load ${layer}-layer policy rules`, cause)
    } finally {
      rulesLoading.value[layer] = false
    }
  }

  async function loadConflicts(layer: PolicyRuleLayer): Promise<void> {
    conflictsError.value[layer] = null
    try {
      conflictsByLayer.value[layer] = await api.listPolicyRuleConflicts(layer)
    } catch (cause) {
      // The per-row `conflict` field from the list response remains authoritative for display;
      // a failed summary request must not be presented as "no conflicts found".
      conflictsByLayer.value[layer] = []
      conflictsError.value[layer] = errorMessage(cause, 'Failed to load policy conflicts')
      logger.warn(`Failed to load ${layer}-layer policy conflicts`, cause)
    }
  }

  async function refreshLayer(layer: PolicyRuleLayer): Promise<void> {
    await Promise.all([loadRules(layer), loadConflicts(layer), loadDomains()])
  }

  async function createRule(draft: PolicyRuleDraft): Promise<PolicyRuleView> {
    creatingRule.value = true
    rulesForbidden.value[draft.layer] = false
    try {
      const created = await api.createPolicyRule({
        layer: draft.layer,
        actionClass: draft.actionClass,
        resource: draft.resource,
        effect: draft.effect,
        priority: draft.priority,
        locked: draft.locked,
      })
      await refreshLayer(draft.layer)
      return created
    } catch (cause) {
      // The caller owns the failure message (inline form); the store only tracks authority.
      rulesForbidden.value[draft.layer] = isForbidden(cause)
      throw cause
    } finally {
      creatingRule.value = false
    }
  }

  async function deleteRule(id: string, layer: PolicyRuleLayer): Promise<void> {
    deletingRuleId.value = id
    try {
      await api.deletePolicyRule(id, layer)
      await refreshLayer(layer)
    } catch (cause) {
      rulesForbidden.value[layer] = isForbidden(cause)
      throw cause
    } finally {
      deletingRuleId.value = null
    }
  }

  async function loadToolFaces(scope: PolicyToolFaceQueryScope): Promise<void> {
    toolFacesScope.value = scope
    toolFacesLoading.value = true
    toolFacesError.value = null
    toolFacesForbidden.value = false
    try {
      toolFaces.value = await api.listPolicyToolFaces(scope)
    } catch (cause) {
      toolFacesError.value = errorMessage(cause, 'Failed to load tool faces')
      toolFacesForbidden.value = isForbidden(cause)
      logger.warn(`Failed to load ${scope}-scope tool faces`, cause)
    } finally {
      toolFacesLoading.value = false
    }
  }

  async function classifyTool(draft: ToolFaceClassificationDraft): Promise<PolicyToolFaceView> {
    classifyingTool.value = true
    toolFacesError.value = null
    toolFacesForbidden.value = false
    try {
      const face = await api.upsertPolicyToolFace(draft)
      await loadToolFaces(draft.scope)
      return face
    } catch (cause) {
      toolFacesError.value = errorMessage(cause, 'Failed to classify tool')
      toolFacesForbidden.value = isForbidden(cause)
      throw cause
    } finally {
      classifyingTool.value = false
    }
  }

  function reset() {
    domains.value = []
    domainsError.value = null
    rulesByLayer.value = createLayerRecord(() => [] as PolicyRuleView[])
    rulesError.value = createLayerRecord(() => null)
    rulesForbidden.value = createLayerRecord(() => false)
    conflictsByLayer.value = createLayerRecord(() => [] as PolicyRuleView[])
    conflictsError.value = createLayerRecord(() => null)
    toolFaces.value = []
    toolFacesError.value = null
    toolFacesForbidden.value = false
  }

  return {
    domains, domainsLoading, domainsError,
    rulesByLayer, rulesLoading, rulesError, rulesForbidden, conflictsByLayer, conflictsError,
    creatingRule, deletingRuleId,
    toolFaces, toolFacesScope, toolFacesLoading, toolFacesError, toolFacesForbidden, classifyingTool,
    loadDomains, loadRules, loadConflicts, createRule, deleteRule,
    loadToolFaces, classifyTool,
    reset,
  }
})
