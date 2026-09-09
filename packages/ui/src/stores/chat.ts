import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Message, MessagePart } from '../types'
import { api } from '../composables/api'
import { useAgentStore } from './agent'

export const XIHE_STORAGE_KEYS = ['xihe-token', 'xihe-user', 'xihe-workspace'] as const

// PLAN-292 M3 (C3): recovery banner tri-state — resumed (run still alive
// server-side, approvals replayable) / cancelled (terminal, nothing running)
// / retry (lease expired or status unknown). 'succeeded' runs set no banner.
export type RunRecoveryState = 'resumed' | 'cancelled' | 'retry'

export interface RunRecovery {
  state: RunRecoveryState
  runId: string
  message: string
}

export const useChatStore = defineStore('chat', () => {
  // Messages are not business data we should resurrect from localStorage.
  // The server is the canonical source via /api/v1/sessions/{id}/messages,
  // and the session store + chat store are cleared on user switch / logout.
  const messages = ref<Record<string, Message[]>>({})
  const streamingMessageId = ref<Record<string, string | null>>({})

  function getMessages(sessionId: string): Message[] {
    return messages.value[sessionId] ?? []
  }

  function getStreamingMessageId(sessionId: string): string | null {
    return streamingMessageId.value[sessionId] ?? null
  }

  function isStreaming(sessionId: string): boolean {
    return streamingMessageId.value[sessionId] !== undefined && streamingMessageId.value[sessionId] !== null
  }

  function addMessage(sessionId: string, message: Message) {
    if (!messages.value[sessionId]) {
      messages.value[sessionId] = []
    }
    messages.value[sessionId].push(message)
  }

  function loadMessages(sessionId: string, sessionMessages: Message[]) {
    // An in-flight response is owned by the live SSE stream. Do not let a
    // slower history request replace its optimistic user/assistant messages.
    if (isStreaming(sessionId)) return
    messages.value[sessionId] = sessionMessages
  }

  function deleteMessage(sessionId: string, messageId: string) {
    const sessionMessages = messages.value[sessionId]
    if (!sessionMessages) return
    messages.value[sessionId] = sessionMessages.filter((msg) => msg.id !== messageId)
  }

  function addMarker(sessionId: string, marker: Omit<Message, 'id' | 'sessionId'>) {
    addMessage(sessionId, {
      id: crypto.randomUUID(),
      sessionId,
      ...marker,
    })
  }

  function createStreamingMessage(sessionId: string, runId?: string): string {
    const id = crypto.randomUUID()
    const message: Message = {
      id,
      sessionId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
      runId,
      runStatus: 'streaming',
    }
    addMessage(sessionId, message)
    streamingMessageId.value[sessionId] = id
    return id
  }

  function appendToParts(sessionId: string, part: MessagePart) {
    const messageId = streamingMessageId.value[sessionId]
    if (!messageId) return

    const msgs = messages.value[sessionId]
    const message = msgs?.find((msg) => msg.id === messageId)
    if (!message) return

    if (!message.parts) {
      message.parts = []
    }

    if (part.type === 'text') {
      const lastText = message.parts.length > 0
        ? message.parts[message.parts.length - 1]
        : null
      if (lastText?.type === 'text') {
        lastText.content += part.content
        return
      }
    }

    if (part.type === 'reasoning') {
      const lastReasoning = message.parts.length > 0
        ? message.parts[message.parts.length - 1]
        : null
      if (lastReasoning?.type === 'reasoning') {
        lastReasoning.content += part.content
        return
      }
    }

    if (part.type === 'artifact') {
      const lastArtifact = message.parts.length > 0
        ? message.parts[message.parts.length - 1]
        : null
      if (lastArtifact?.type === 'artifact' && lastArtifact.identifier === part.identifier) {
        lastArtifact.content += part.content
        return
      }
    }

    message.parts.push(part)
  }

  function replaceStreamingParts(sessionId: string, nextParts: MessagePart[]) {
    const messageId = streamingMessageId.value[sessionId]
    if (!messageId) return

    const message = messages.value[sessionId]?.find((msg) => msg.id === messageId)
    if (!message) return

    message.parts = [...nextParts]
  }

  function finalizeStreaming(sessionId: string) {
    const messageId = streamingMessageId.value[sessionId]
    if (!messageId) {
      return
    }

    const message = messages.value[sessionId]?.find((msg) => msg.id === messageId)
    if (message) {
      message.isStreaming = false
      message.runStatus = 'succeeded'
      message.terminalOutcome = 'success'
      if (message.parts) {
        message.content = message.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.content)
          .join('')
      }
    }

    streamingMessageId.value[sessionId] = null
  }

  function markStreamingError(sessionId: string, error: {
    code: string
    detail: string
    runId?: string
    retryable?: boolean
    outcome?: string
  }) {
    const messageId = streamingMessageId.value[sessionId]
    if (!messageId) return

    const message = messages.value[sessionId]?.find((msg) => msg.id === messageId)
    if (message) {
      const hasContent = Boolean(
        message.content || message.parts?.some((part) => part.type !== 'citation' && Boolean(part.content)),
      )
      if (!hasContent) {
        messages.value[sessionId] = messages.value[sessionId].filter((msg) => msg.id !== messageId)
        streamingMessageId.value[sessionId] = null
        if (error.runId) void refreshRunRecovery(sessionId, error.runId)
        return
      }
      message.isStreaming = false
      message.errorCode = error.code
      message.error = error.detail
      message.retryable = error.retryable ?? true
      message.runId = error.runId ?? message.runId
      const ambiguous = error.outcome === 'ambiguous'
      const partial = !ambiguous && (hasContent || error.outcome === 'partial')
      message.runStatus = ambiguous ? 'ambiguous' : partial ? 'partial' : 'failed'
      message.terminalOutcome = ambiguous ? 'ambiguous' : partial ? 'partial' : 'error'
      if (message.parts) {
        message.content = message.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.content)
          .join('')
      }
    }

    streamingMessageId.value[sessionId] = null
    if (error.runId) void refreshRunRecovery(sessionId, error.runId)
  }

  const runRecovery = ref<Record<string, RunRecovery | undefined>>({})

  // PLAN-292 M3 (C2): ask the CP what actually happened to the run behind a
  // dead SSE stream. Server truth decides the banner; never fabricate a state.
  async function refreshRunRecovery(sessionId: string, runId: string): Promise<void> {
    try {
      const res = await api.getChatRunStatus(runId)
      if (res.status === 'awaiting_approval' || (res.status === 'running' && !res.leaseExpired)) {
        runRecovery.value[sessionId] = {
          state: 'resumed',
          runId,
          message: '会话已恢复，任务仍在执行，待审批操作可继续处理',
        }
        const agentStore = useAgentStore()
        for (const approval of res.pendingApprovals ?? []) {
          agentStore.addApprovalRequest(approval as unknown as Parameters<typeof agentStore.addApprovalRequest>[0])
        }
      } else if (['cancelling', 'cancelled', 'failed', 'ambiguous'].includes(res.status)) {
        runRecovery.value[sessionId] = {
          state: 'cancelled',
          runId,
          message: '任务已取消或结束，未完成的执行不会继续',
        }
      } else if (res.status === 'running' && res.leaseExpired) {
        runRecovery.value[sessionId] = {
          state: 'retry',
          runId,
          message: '任务执行租约已过期，请重试',
        }
      } else {
        // succeeded — history already shows the final message, no banner.
        delete runRecovery.value[sessionId]
      }
    } catch {
      runRecovery.value[sessionId] = {
        state: 'retry',
        runId,
        message: '无法确认任务状态，请重试',
      }
    }
  }

  function dismissRunRecovery(sessionId: string) {
    delete runRecovery.value[sessionId]
  }

  function clearSession(sessionId: string) {
    delete messages.value[sessionId]
    delete streamingMessageId.value[sessionId]
  }

  function deleteSession(sessionId: string) {
    clearSession(sessionId)
  }

  function clearAllData() {
    for (const key of XIHE_STORAGE_KEYS) {
      try {
        localStorage.removeItem(key)
      } catch {
        // ignore
      }
    }
    messages.value = {}
    streamingMessageId.value = {}
  }

  function clearForUserSwitch() {
    messages.value = {}
    streamingMessageId.value = {}
  }

  return {
    messages,
    streamingMessageId,
    runRecovery,
    getMessages,
    getStreamingMessageId,
    isStreaming,
    addMessage,
    loadMessages,
    deleteMessage,
    addMarker,
    createStreamingMessage,
    appendToParts,
    replaceStreamingParts,
    finalizeStreaming,
    markStreamingError,
    refreshRunRecovery,
    dismissRunRecovery,
    clearSession,
    deleteSession,
    clearAllData,
    clearForUserSwitch,
  }
})
