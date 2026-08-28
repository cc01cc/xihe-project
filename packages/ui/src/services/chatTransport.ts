import { fetchEventSource, type EventSourceMessage } from '@microsoft/fetch-event-source'
import { logger } from '@/lib/logger'
import { apiAuthHeaders, apiErrorFromResponse } from '@/composables/api'

export interface ChatTransportOptions {
  url: string
  headers?: Record<string, string>
  body?: unknown
  method?: 'GET' | 'POST'
  onopen?: (response: Response) => void | Promise<void>
  onmessage?: (event: EventSourceMessage) => void | Promise<void>
  onerror?: (error: Error) => void | Promise<void>
  onclose?: () => void | Promise<void>
  signal?: AbortSignal
}

export interface ChatTransportState {
  isConnected: boolean
  isConnecting: boolean
}

class ChatTransportImpl {
  private controllers = new Map<string, AbortController>()
  private states = new Map<string, ChatTransportState>()

  getState(sessionId: string): ChatTransportState {
    return this.states.get(sessionId) ?? { isConnected: false, isConnecting: false }
  }

  private setState(sessionId: string, patch: Partial<ChatTransportState>): void {
    const current = this.getState(sessionId)
    this.states.set(sessionId, { ...current, ...patch })
  }

  async sendMessages(sessionId: string, options: ChatTransportOptions): Promise<void> {
    this.stop(sessionId)

    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    this.setState(sessionId, { isConnecting: true, isConnected: false })

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort())
    }

    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined
    const method = options.method ?? (body ? 'POST' : 'GET')

    try {
      await fetchEventSource(options.url, {
        method,
        headers: {
          Accept: 'text/event-stream',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...apiAuthHeaders(options.headers, Boolean(body)),
        },
        body,
        signal: controller.signal,
        openWhenHidden: false,
        onopen: async (response) => {
          if (response.status === 401) {
            this.handleUnauthorized()
            controller.abort()
            return
          }
          if (!response.ok) {
            const err = await apiErrorFromResponse(response)
            logger.warn('SSE onopen error', err)
            await options.onerror?.(err)
            return
          }
          this.setState(sessionId, { isConnected: true, isConnecting: false })
          await options.onopen?.(response)
        },
        onmessage: (msg) => {
          void options.onmessage?.(msg)
        },
        onerror: (err) => {
          if (this.isUnauthorizedError(err)) {
            this.handleUnauthorized()
            controller.abort()
            return
          }
          logger.warn('SSE transport error', err)
          void options.onerror?.(err)
        },
        onclose: () => {
          this.setState(sessionId, { isConnected: false, isConnecting: false })
          void options.onclose?.()
        },
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      if (err.name === 'AbortError') {
        this.setState(sessionId, { isConnected: false, isConnecting: false })
        return
      }
      logger.warn('fetchEventSource threw', err)
      this.setState(sessionId, { isConnected: false, isConnecting: false })
      throw err
    }
  }

  stop(sessionId: string): void {
    const controller = this.controllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.controllers.delete(sessionId)
    }
    this.setState(sessionId, { isConnected: false, isConnecting: false })
  }

  stopAll(): void {
    for (const sessionId of this.controllers.keys()) {
      this.stop(sessionId)
    }
  }

  private isUnauthorizedError(error: Error): boolean {
    const message = error.message.toLowerCase()
    return message.includes('401') || message.includes('unauthorized')
  }

  private handleUnauthorized(): void {
    localStorage.removeItem('xihe-token')
    localStorage.removeItem('xihe-user')
    window.location.href = '/login'
  }
}

export const chatTransport = new ChatTransportImpl()

export function useChatTransport(): ChatTransportImpl {
  return chatTransport
}
