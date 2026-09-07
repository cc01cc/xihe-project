import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ApprovalRequest, ToolCall, AgentState } from '../types'

export const useAgentStore = defineStore('agent', () => {
  const agentState = ref<AgentState>({
    status: 'idle',
    currentToolCall: null,
    pendingApprovals: [],
  })

  const toolCalls = ref<ToolCall[]>([])

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

  function addApprovalRequest(request: ApprovalRequest) {
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

  function removeApprovalRequest(requestId: string) {
    const idx = agentState.value.pendingApprovals.findIndex((item) => item.requestId === requestId)
    if (idx >= 0) agentState.value.pendingApprovals.splice(idx, 1)
    if (agentState.value.pendingApprovals.length === 0 && agentState.value.status === 'awaiting_approval') {
      agentState.value.status = 'thinking'
    }
  }

  function approveTool(requestId: string) {
    removeApprovalRequest(requestId)
  }

  function rejectTool(requestId: string) {
    removeApprovalRequest(requestId)
  }

  function reset() {
    agentState.value = {
      status: 'idle',
      currentToolCall: null,
      pendingApprovals: [],
    }
    toolCalls.value = []
  }

  return {
    agentState,
    toolCalls,
    setStatus,
    addToolCall,
    updateToolCall,
    addApprovalRequest,
    removeApprovalRequest,
    approveTool,
    rejectTool,
    reset,
  }
})
