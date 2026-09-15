import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { ApiError, api, type ChatApprovalDecisionResponse } from '../composables/api'
import { logger } from '../lib/logger'
import type { ApprovalDecision, ApprovalRequest, ApprovalRequestState, AgentState, PendingApprovalSummary, ToolCall } from '../types'

export const useAgentStore = defineStore('agent', () => {
  const agentState = ref<AgentState>({
    status: 'idle',
    currentToolCall: null,
    pendingApprovals: [],
  })

  const toolCalls = ref<ToolCall[]>([])
  // Endpoint summaries intentionally stay separate from full approval requests:
  // they contain no tool arguments and are safe for shell-level indicators.
  const pendingApprovalSummaries = ref<PendingApprovalSummary[]>([])
  const pendingApprovalsLoading = ref(false)
  const pendingApprovalsError = ref<string | null>(null)
  const resolvedApprovals = ref<Record<string, ApprovalRequest>>({})
  const pendingSummaryScopeWorkspaceId = ref<string | null>(null)
  let storeGeneration = 0
  let approvalEpoch = 0
  const sessionApprovalEpochs = new Map<string, number>()
  let pendingRefresh: Promise<PendingApprovalSummary[]> | null = null
  let pendingRefreshController: AbortController | null = null
  const decisionPromises = new Map<string, Promise<ChatApprovalDecisionResponse>>()
  const decisionTokens = new Map<string, symbol>()

  function getApprovalEpoch(sessionId: string): string {
    return `${approvalEpoch}:${sessionApprovalEpochs.get(sessionId) ?? 0}`
  }

  function isApprovalEpochCurrent(sessionId: string, epoch: string): boolean {
    return getApprovalEpoch(sessionId) === epoch
  }

  function invalidateAllApprovalEpochs() {
    approvalEpoch += 1
    sessionApprovalEpochs.clear()
  }

  function invalidateSessionApprovalEpoch(sessionId: string) {
    sessionApprovalEpochs.set(sessionId, (sessionApprovalEpochs.get(sessionId) ?? 0) + 1)
  }

  const pendingApprovalTotal = computed(() => pendingApprovalSummaries.value.reduce((total, summary) => total + summary.count, 0))

  function pendingApprovalCount(sessionId: string): number {
    return pendingApprovalSummaries.value.find((summary) => summary.sessionId === sessionId)?.count ?? 0
  }

  function setStatus(status: AgentState['status']) {
    agentState.value.status = status
  }

  function addToolCall(toolCall: ToolCall) {
    toolCalls.value.push(toolCall)
    agentState.value.currentToolCall = toolCall
    agentState.value.status = 'executing'
  }

  function updateToolCall(id: string, updates: Partial<ToolCall>) {
    const tc = toolCalls.value.find((t) => t.id === id)
    if (tc) {
      Object.assign(tc, updates)
    }
    if (agentState.value.currentToolCall?.id === id) {
      const merged: ToolCall = { ...agentState.value.currentToolCall, ...updates }
      agentState.value.currentToolCall = merged
    }
    if (updates.status === 'completed' || updates.status === 'failed') {
      agentState.value.currentToolCall = null
      const hasRunning = toolCalls.value.some((t) => t.status === 'running' || t.status === 'pending')
      if (!hasRunning) {
        agentState.value.status = 'thinking'
      }
    }
  }

  function rememberResolved(request: ApprovalRequest, state: ApprovalRequestState) {
    resolvedApprovals.value[request.requestId] = { ...request, state }
  }

  function isTerminalApprovalState(state: ApprovalRequestState | undefined): state is 'approved' | 'rejected' | 'expired' {
    return state === 'approved' || state === 'rejected' || state === 'expired'
  }

  function isActionableApprovalState(state: ApprovalRequestState | undefined): boolean {
    return state === undefined || state === 'pending' || state === 'dispatch_unknown'
  }

  function addApprovalRequest(request: ApprovalRequest) {
    const resolved = resolvedApprovals.value[request.requestId]
    if (resolved && isTerminalApprovalState(resolved.state)) {
      return
    }

    if (isTerminalApprovalState(request.state)) {
      const existing = agentState.value.pendingApprovals.find((item) => item.requestId === request.requestId)
      if (existing) {
        removeApprovalRequest(request.requestId, request.state)
      } else {
        rememberResolved({ ...(resolved ?? {}), ...request }, request.state)
      }
      return
    }

    // A late authoritative recovery event can move an in-flight row from
    // dispatching back to the explicit retryable state. Other non-actionable
    // replay states stay tombstoned and must not reopen the modal.
    if (resolved) {
      if (resolved.state === 'dispatching' && request.state === 'dispatch_unknown') {
        delete resolvedApprovals.value[request.requestId]
      } else {
        return
      }
    }

    if (request.state === 'dispatching') {
      const existing = agentState.value.pendingApprovals.find((item) => item.requestId === request.requestId)
      if (existing) {
        removeApprovalRequest(request.requestId, request.state)
      } else {
        rememberResolved(request, request.state)
      }
      return
    }

    if (!isActionableApprovalState(request.state)) return

    const existing = agentState.value.pendingApprovals.findIndex((item) => item.requestId === request.requestId)
    if (existing >= 0) {
      agentState.value.pendingApprovals[existing] = {
        ...agentState.value.pendingApprovals[existing],
        ...request,
      }
    } else {
      agentState.value.pendingApprovals.push(request)
    }
    agentState.value.status = 'awaiting_approval'
  }

  function removeApprovalRequest(requestId: string, terminalState: ApprovalRequestState = 'dispatch_unknown') {
    const existing = agentState.value.pendingApprovals.find((item) => item.requestId === requestId)
    if (existing) rememberResolved(existing, terminalState)
    const idx = agentState.value.pendingApprovals.findIndex((item) => item.requestId === requestId)
    if (idx >= 0) agentState.value.pendingApprovals.splice(idx, 1)
    if (agentState.value.pendingApprovals.length === 0 && agentState.value.status === 'awaiting_approval') {
      agentState.value.status = 'thinking'
    }
  }

  async function refreshPendingApprovals(force = false, workspaceId?: string): Promise<PendingApprovalSummary[]> {
    if (workspaceId !== undefined) pendingSummaryScopeWorkspaceId.value = workspaceId
    const scopeWorkspaceId = workspaceId ?? pendingSummaryScopeWorkspaceId.value ?? undefined
    if (pendingRefresh && force) {
      const activeRefresh = pendingRefresh
      await activeRefresh
      if (pendingRefresh === activeRefresh) pendingRefresh = null
    }
    if (pendingRefresh) return pendingRefresh

    const generation = storeGeneration
    const controller = new AbortController()
    const request = (async () => {
      pendingApprovalsLoading.value = true
      pendingApprovalsError.value = null
      pendingRefreshController = controller
      try {
        const summaries = await api.getPendingApprovals(controller.signal)
        if (generation === storeGeneration) {
          pendingApprovalSummaries.value = summaries
          reconcilePendingApprovals(summaries, scopeWorkspaceId)
        }
        return summaries
      } catch (cause) {
        if (generation === storeGeneration) {
          pendingApprovalsError.value = cause instanceof Error ? cause.message : 'Failed to load pending approvals'
          logger.warn('Failed to refresh pending approvals', cause)
          if (cause instanceof ApiError && (cause.problem.status === 401 || cause.problem.status === 403)) {
            reset()
            return []
          }
          // Keep the last known summaries so a transient poll failure does not
          // silently hide an approval that still needs a decision.
          return pendingApprovalSummaries.value
        }
        return []
      } finally {
        if (pendingRefreshController === controller) pendingRefreshController = null
        if (generation === storeGeneration) pendingApprovalsLoading.value = false
      }
    })()
    pendingRefresh = request
    try {
      return await request
    } finally {
      if (pendingRefresh === request) pendingRefresh = null
    }
  }

  function reconcilePendingApprovals(summaries: PendingApprovalSummary[], workspaceId?: string) {
    const scopedSummaries = summaries.filter((summary) => workspaceId === undefined || summary.workspaceId === workspaceId)
    const pendingSessions = new Set(scopedSummaries
      .filter((summary) => summary.count > 0)
      .map((summary) => summary.sessionId))
    for (let index = agentState.value.pendingApprovals.length - 1; index >= 0; index -= 1) {
      const request = agentState.value.pendingApprovals[index]
      const requestInScope = workspaceId === undefined
        ? true
        : request.workspaceId === workspaceId
      if (requestInScope && !pendingSessions.has(request.sessionId)) {
        removeApprovalRequest(request.requestId, 'dispatch_unknown')
      }
    }
  }

  function abortPendingRefresh() {
    pendingRefreshController?.abort()
  }

  function decideApproval(requestId: string, decision: ApprovalDecision): Promise<ChatApprovalDecisionResponse> {
    const existing = decisionPromises.get(requestId)
    if (existing) return existing

    const token = Symbol(requestId)
    const generation = storeGeneration
    const request = (async () => {
      try {
        const response = await api.decideChatApproval(requestId, decision)
        // `accepted` and `already_decided` are both terminal from the UI's
        // perspective. The server response is authoritative for propagation.
        if (generation === storeGeneration && (response.status === 'accepted' || response.status === 'already_decided')) {
          const terminalState: ApprovalRequestState = response.approved ? 'approved' : 'rejected'
          removeApprovalRequest(requestId, terminalState)
        }
        if (generation === storeGeneration) void refreshPendingApprovals(true)
        return response
      } finally {
        if (decisionTokens.get(requestId) === token) {
          decisionTokens.delete(requestId)
          decisionPromises.delete(requestId)
        }
      }
    })()
    decisionTokens.set(requestId, token)
    decisionPromises.set(requestId, request)
    return request
  }

  function approveTool(requestId: string) {
    removeApprovalRequest(requestId)
  }

  function rejectTool(requestId: string) {
    removeApprovalRequest(requestId)
  }

  function resolveApprovalsForRun(sessionId: string, runId: string, state: ApprovalRequestState = 'dispatch_unknown') {
    for (let index = agentState.value.pendingApprovals.length - 1; index >= 0; index -= 1) {
      const request = agentState.value.pendingApprovals[index]
      if (request.sessionId === sessionId && request.runId === runId) {
        removeApprovalRequest(request.requestId, state)
      }
    }
  }

  function clearSession(sessionId: string) {
    invalidateSessionApprovalEpoch(sessionId)
    storeGeneration += 1
    pendingRefreshController?.abort()
    pendingRefreshController = null
    pendingRefresh = null
    agentState.value.pendingApprovals = agentState.value.pendingApprovals.filter((item) => item.sessionId !== sessionId)
    pendingApprovalSummaries.value = pendingApprovalSummaries.value.filter((summary) => summary.sessionId !== sessionId)
    for (const [requestId, request] of Object.entries(resolvedApprovals.value)) {
      if (request.sessionId === sessionId) delete resolvedApprovals.value[requestId]
    }
    if (agentState.value.pendingApprovals.length === 0 && agentState.value.status === 'awaiting_approval') {
      agentState.value.status = 'thinking'
    }
    pendingApprovalsLoading.value = false
  }

  function clearPendingApprovals() {
    invalidateAllApprovalEpochs()
    storeGeneration += 1
    pendingRefreshController?.abort()
    pendingRefreshController = null
    pendingRefresh = null
    decisionPromises.clear()
    decisionTokens.clear()
    pendingApprovalSummaries.value = []
    pendingSummaryScopeWorkspaceId.value = null
    agentState.value.pendingApprovals = []
    resolvedApprovals.value = {}
    pendingApprovalsLoading.value = false
    pendingApprovalsError.value = null
    if (agentState.value.status === 'awaiting_approval') agentState.value.status = 'idle'
  }

  function reset() {
    invalidateAllApprovalEpochs()
    pendingRefreshController?.abort()
    pendingRefreshController = null
    storeGeneration += 1
    decisionPromises.clear()
    decisionTokens.clear()
    pendingRefresh = null
    agentState.value = {
      status: 'idle',
      currentToolCall: null,
      pendingApprovals: [],
    }
    toolCalls.value = []
    pendingApprovalSummaries.value = []
    pendingSummaryScopeWorkspaceId.value = null
    resolvedApprovals.value = {}
    pendingApprovalsLoading.value = false
    pendingApprovalsError.value = null
  }

  return {
    agentState,
    toolCalls,
    pendingApprovalSummaries,
    pendingApprovalsLoading,
    pendingApprovalsError,
    resolvedApprovals,
    getApprovalEpoch,
    isApprovalEpochCurrent,
    pendingApprovalTotal,
    pendingApprovalCount,
    setStatus,
    addToolCall,
    updateToolCall,
    addApprovalRequest,
    removeApprovalRequest,
    approveTool,
    rejectTool,
    resolveApprovalsForRun,
    decideApproval,
    refreshPendingApprovals,
    abortPendingRefresh,
    clearSession,
    clearPendingApprovals,
    reset,
  }
})
