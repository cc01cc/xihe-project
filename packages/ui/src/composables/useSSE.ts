import { ref, onUnmounted, getCurrentInstance, toValue, type MaybeRefOrGetter } from 'vue'
import { useAgentStore } from '../stores/agent'
import { logger } from '../lib/logger'
import { chatTransport } from '../services/chatTransport'
import { ApiError, apiAuthHeaders, apiRaw } from './api'
import type { EventSourceMessage } from '@microsoft/fetch-event-source'
import type { ChatRunResponse } from '../types'

interface LangChainTextBlock {
  type: string
  text?: string
}

function normalizeTokenContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === 'string') return block
        const b = block as LangChainTextBlock
        if (b.type === 'text' && typeof b.text === 'string') return b.text
        return ''
      })
      .join('')
  }
  return ''
}

export interface SSECallbacks {
  onStart?: () => void
  onToken?: (token: string, hint?: 'reasoning' | 'text') => void
  onToolCall?: (name: string, args: Record<string, unknown>) => void
  onToolResult?: (data: Record<string, unknown>) => void
  onApprovalRequest?: (data: Record<string, unknown>) => void
  onStatus?: (status: string) => void
  onError?: (error: SSEErrorPayload) => void
  onDone?: (outcome?: string) => void
}

export interface SSEErrorPayload {
  code: string
  detail: string
  requestId?: string
  runId?: string
  provider?: string
  model?: string
  retryable?: boolean
  outcome?: string
}

export interface SendMessageOptions {
  content: string
  attachments?: string[]
  model?: string
  sessionId?: string
  provider?: string
  toolMode?: 'none' | 'workspace'
  idempotencyKey?: string
}

const STREAM_TIMEOUT_MS = 30000

export function useSSE(sessionId: MaybeRefOrGetter<string>) {
  const isConnected = ref(false)
  const isStreaming = ref(false)
  const error = ref<string | null>(null)
  let currentCallbacks: SSECallbacks = {}
  let streamTimeout: ReturnType<typeof setTimeout> | null = null
  let connectionErrorReported = false
  let activeSessionId: string | null = null
  let contentStarted = false

  function asErrorPayload(error: unknown, fallbackCode = 'AGENT_STREAM_FAILED'): SSEErrorPayload {
    if (error instanceof ApiError) {
      return {
        code: error.problem.code,
        detail: error.problem.detail ?? error.message,
        requestId: error.problem.requestId,
        runId: error.problem.runId,
        provider: error.problem.provider,
        model: error.problem.model,
        retryable: error.problem.retryable,
        outcome: error.problem.outcome,
      }
    }
    return {
      code: fallbackCode,
      detail: error instanceof Error ? error.message : String(error),
      retryable: true,
      outcome: 'error',
    }
  }

  function errorText(error: SSEErrorPayload): string {
    return error.detail ? `${error.code}: ${error.detail}` : error.code
  }

  function resetStreamTimeout() {
    if (streamTimeout) clearTimeout(streamTimeout)
    streamTimeout = setTimeout(() => {
      if (isStreaming.value) {
        isStreaming.value = false
        const timeoutError: SSEErrorPayload = {
          code: 'AGENT_TIMEOUT',
          detail: 'Agent stream timed out',
          retryable: true,
          outcome: contentStarted ? 'ambiguous' : 'error',
        }
        error.value = errorText(timeoutError)
        currentCallbacks.onError?.(timeoutError)
        currentCallbacks.onDone?.(timeoutError.outcome)
      }
    }, STREAM_TIMEOUT_MS)
  }

  function clearStreamTimeout() {
    if (streamTimeout) {
      clearTimeout(streamTimeout)
      streamTimeout = null
    }
  }

  function handleMessage(msg: EventSourceMessage) {
    switch (msg.event) {
      case 'token':
        try {
          const data = JSON.parse(msg.data) as { content?: unknown; hint?: string }
          const content = normalizeTokenContent(data.content)
          const hint = data.hint === 'reasoning' || data.hint === 'text' ? data.hint : undefined
          if (content) {
            if (!contentStarted) {
              contentStarted = true
              isStreaming.value = true
              currentCallbacks.onStart?.()
            }
            resetStreamTimeout()
            currentCallbacks.onToken?.(content, hint)
          }
        } catch {
          logger.warn('Failed to parse SSE token event')
        }
        break

      case 'tool_call':
        try {
          const data = JSON.parse(msg.data) as Record<string, unknown>
          if (data.name) {
            const store = useAgentStore()
            store.addToolCall({
              id: String(data.id ?? crypto.randomUUID()),
              name: String(data.name),
              arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments),
              status: 'running',
            })
          }
          currentCallbacks.onToolCall?.(String(data.name), (data.arguments ?? {}) as Record<string, unknown>)
        } catch {
          logger.warn('Failed to parse SSE tool_call event')
        }
        break

      case 'tool_result':
        try {
          const data = JSON.parse(msg.data) as Record<string, unknown>
          if (data.id) {
            const store = useAgentStore()
            store.updateToolCall(String(data.id), {
              result: typeof data.result === 'string' ? data.result : JSON.stringify(data.result),
              status: 'completed',
            })
          }
          currentCallbacks.onToolResult?.(data)
        } catch {
          logger.warn('Failed to parse SSE tool_result event')
        }
        break

      case 'approval_request':
        try {
          const data = JSON.parse(msg.data) as Record<string, unknown>
          const requestId = typeof data.requestId === 'string' ? data.requestId : ''
          if (requestId) {
            const store = useAgentStore()
            store.addApprovalRequest({
              requestId,
              operationId: typeof data.operationId === 'string' ? data.operationId : undefined,
              runId: String(data.runId ?? ''),
              sessionId: String(data.sessionId ?? activeSessionId ?? ''),
              workspaceId: typeof data.workspaceId === 'string' ? data.workspaceId : undefined,
              tool: String(data.tool ?? 'request_approval'),
              action: String(data.action ?? ''),
              details: String(data.details ?? ''),
              expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : undefined,
              replayed: data.replayed === true,
              state: 'pending',
            })
          }
          currentCallbacks.onApprovalRequest?.(data)
        } catch {
          logger.warn('Failed to parse SSE approval_request event')
        }
        break

      case 'status':
        try {
          const data = JSON.parse(msg.data) as { status?: string }
          if (data.status) {
            currentCallbacks.onStatus?.(data.status)
          }
        } catch {
          logger.warn('Failed to parse SSE status event')
        }
        break

      case 'error':
        isStreaming.value = false
        clearStreamTimeout()
        try {
          const data = JSON.parse(msg.data) as {
            error?: string
            details?: string
            detail?: string
            code?: string
            requestId?: string
            runId?: string
            provider?: string
            model?: string
            retryable?: boolean
            outcome?: string
          }
          const payload: SSEErrorPayload = {
            code: data.code ?? 'AGENT_STREAM_FAILED',
            detail: data.detail ?? data.error ?? data.details ?? 'Unknown error',
            requestId: data.requestId,
            runId: data.runId,
            provider: data.provider,
            model: data.model,
            retryable: data.retryable,
            outcome: data.outcome ?? (contentStarted ? 'partial' : 'error'),
          }
          error.value = errorText(payload)
          currentCallbacks.onError?.(payload)
        } catch {
          logger.warn('Failed to parse SSE error event payload')
          const payload: SSEErrorPayload = {
            code: 'AGENT_STREAM_FAILED',
            detail: 'Unknown error',
            retryable: true,
            outcome: contentStarted ? 'partial' : 'error',
          }
          error.value = errorText(payload)
          currentCallbacks.onError?.(payload)
        }
        break

      case 'done':
        isStreaming.value = false
        clearStreamTimeout()
        try {
          const data = msg.data ? JSON.parse(msg.data) as { outcome?: string } : {}
          currentCallbacks.onDone?.(data.outcome)
        } catch {
          logger.warn('Failed to parse SSE done event payload')
          currentCallbacks.onDone?.()
        }
        break

      default:
        break
    }
  }

  function connect(callbacks: SSECallbacks = {}) {
    disconnect()
    currentCallbacks = callbacks
    contentStarted = false

    const currentSessionId = toValue(sessionId)
    activeSessionId = currentSessionId

    const url = `/api/v1/events?sessionId=${encodeURIComponent(currentSessionId)}`

    chatTransport
      .sendMessages(currentSessionId, {
        url,
        headers: apiAuthHeaders(undefined, false),
        onopen: () => {
          isConnected.value = true
          error.value = null
          connectionErrorReported = false
        },
        onmessage: handleMessage,
        onerror: (err) => {
          const msg = err.message || 'SSE connection error'
          logger.warn('useSSE connection error', err)
          error.value = msg
        },
        onclose: () => {
          isConnected.value = false
        },
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return
        logger.warn('useSSE connect failed', err)
        const payload = asErrorPayload(err, 'SSE_CONNECTION_FAILED')
        error.value = errorText(payload)
        if (!connectionErrorReported) {
          connectionErrorReported = true
          currentCallbacks.onError?.(payload)
        }
      })
  }

  function disconnect() {
    const sessionToStop = activeSessionId ?? toValue(sessionId)
    chatTransport.stop(sessionToStop)
    activeSessionId = null
    isConnected.value = false
    isStreaming.value = false
    contentStarted = false
    clearStreamTimeout()
  }

  async function sendMessage({ content, attachments, model, provider, toolMode, idempotencyKey, sessionId: overrideSid }: SendMessageOptions): Promise<ChatRunResponse | null> {
    error.value = null
    contentStarted = false
    const sid = overrideSid ?? toValue(sessionId)

    try {
      const body: Record<string, unknown> = {
        content,
        sessionId: sid,
        stream: true,
      }
      if (model) {
        body.model = model
      }
      if (provider) {
        body.provider = provider
      }
      body.toolMode = toolMode ?? 'none'
      if (attachments && attachments.length > 0) {
        body.attachments = attachments
      }

      const response = await apiRaw('/chat', {
        method: 'POST',
        headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
        body: JSON.stringify(body),
      })
      const result = await response.json() as ChatRunResponse
      isStreaming.value = true
      return result
    } catch (err) {
      const payload = asErrorPayload(err)
      logger.error('Failed to send message via SSE: ' + errorText(payload))
      error.value = errorText(payload)
      isStreaming.value = false
      currentCallbacks.onError?.(payload)
      return null
    }
  }

  if (getCurrentInstance()) {
    onUnmounted(() => {
      disconnect()
    })
  }

  return {
    isConnected,
    isStreaming,
    error,
    connect,
    disconnect,
    sendMessage,
  }
}
