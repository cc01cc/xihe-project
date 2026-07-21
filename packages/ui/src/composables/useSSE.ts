import { ref, onUnmounted, getCurrentInstance } from 'vue'
import { useAgentStore } from '../stores/agent'
import { logger } from '../lib/logger'
import { chatTransport } from '../services/chatTransport'
import type { EventSourceMessage } from '@microsoft/fetch-event-source'

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
  onError?: (error: string) => void
  onDone?: () => void
}

export interface SendMessageOptions {
  content: string
  attachments?: string[]
  model?: string
  sessionId?: string
}

const STREAM_TIMEOUT_MS = 30000

export function useSSE(sessionId: string) {
  const isConnected = ref(false)
  const isStreaming = ref(false)
  const error = ref<string | null>(null)
  let currentCallbacks: SSECallbacks = {}
  let streamTimeout: ReturnType<typeof setTimeout> | null = null
  let connectionErrorReported = false

  function resetStreamTimeout() {
    if (streamTimeout) clearTimeout(streamTimeout)
    streamTimeout = setTimeout(() => {
      if (isStreaming.value) {
        isStreaming.value = false
        currentCallbacks.onDone?.()
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
        if (!isStreaming.value) {
          isStreaming.value = true
          currentCallbacks.onStart?.()
        }
        resetStreamTimeout()
        try {
          const data = JSON.parse(msg.data) as { content?: unknown; hint?: string }
          const content = normalizeTokenContent(data.content)
          const hint = data.hint === 'reasoning' || data.hint === 'text' ? data.hint : undefined
          if (content) {
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
          if (data.id) {
            const store = useAgentStore()
            store.addApprovalRequest({
              id: String(data.id),
              name: String(data.name ?? 'unknown'),
              arguments: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments),
              status: 'pending',
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
        try {
          const data = JSON.parse(msg.data) as { error?: string; details?: string }
          const msgText = data.details ? `${data.error}: ${data.details}` : (data.error ?? 'Unknown error')
          error.value = msgText
          currentCallbacks.onError?.(msgText)
        } catch {
          logger.warn('Failed to parse SSE error event payload')
          error.value = 'Unknown error'
          currentCallbacks.onError?.('Unknown error')
        }
        break

      case 'done':
        isStreaming.value = false
        clearStreamTimeout()
        currentCallbacks.onDone?.()
        break

      default:
        break
    }
  }

  function connect(callbacks: SSECallbacks = {}) {
    disconnect()
    currentCallbacks = callbacks

    const token = localStorage.getItem('xihe-token')
    const url = `/api/v1/events?session_id=${encodeURIComponent(sessionId)}`

    chatTransport
      .sendMessages(sessionId, {
        url,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
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
        error.value = err.message
        if (!connectionErrorReported) {
          connectionErrorReported = true
          currentCallbacks.onError?.(err.message)
        }
      })
  }

  function disconnect() {
    chatTransport.stop(sessionId)
    isConnected.value = false
    isStreaming.value = false
    clearStreamTimeout()
  }

  async function sendMessage({ content, attachments, model, sessionId: overrideSid }: SendMessageOptions) {
    error.value = null
    isStreaming.value = true
    const sid = overrideSid ?? sessionId

    try {
      const body: Record<string, unknown> = {
        content,
        session_id: sid,
        stream: true,
      }
      if (model) {
        body.model = model
      }
      if (attachments && attachments.length > 0) {
        body.attachments = attachments
      }

      const token = localStorage.getItem('xihe-token')
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }

      const response = await fetch('/api/v1/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })

      if (response.status === 401) {
        localStorage.removeItem('xihe-token')
        localStorage.removeItem('xihe-user')
        window.location.href = '/login'
        throw new Error('Session expired')
      }
      if (!response.ok) {
        const errBody = await response.json().catch(() => null) as { message?: string } | null
        throw new Error(errBody?.message ?? `HTTP ${response.status}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('Failed to send message via SSE: ' + msg)
      error.value = msg
      isStreaming.value = false
      currentCallbacks.onError?.(msg)
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
