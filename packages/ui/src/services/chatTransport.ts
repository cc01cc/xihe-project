import { fetchEventSource, type EventSourceMessage } from '@microsoft/fetch-event-source'
import { logger } from '@/lib/logger'
import { ApiError, apiAuthHeaders, apiErrorFromResponse } from '@/composables/api'

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
  connectionGeneration: number
  reconnectAttempt: number
}

class ChatTransportImpl {
  private controllers = new Map<string, AbortController>()
  private states = new Map<string, ChatTransportState>()
  private connectionPromises = new Map<string, Promise<void>>()
  private connectionOptions = new Map<string, ChatTransportOptions>()
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private intentionalStops = new Set<string>()
  private generations = new Map<string, number>()

  getState(sessionId: string): ChatTransportState {
    return this.states.get(sessionId) ?? {
      isConnected: false,
      isConnecting: false,
      connectionGeneration: 0,
      reconnectAttempt: 0,
    }
  }

  private setState(sessionId: string, patch: Partial<ChatTransportState>): void {
    const current = this.getState(sessionId)
    this.states.set(sessionId, { ...current, ...patch })
  }

  async sendMessages(sessionId: string, options: ChatTransportOptions): Promise<void> {
    const current = this.getState(sessionId)
    const existing = this.connectionPromises.get(sessionId)
    if (existing && (current.isConnected || current.isConnecting)) {
      return existing
    }

    this.connectionOptions.set(sessionId, options)
    this.intentionalStops.delete(sessionId)
    this.clearReconnectTimer(sessionId)
    const promise = this.openConnection(sessionId, options)
    this.connectionPromises.set(sessionId, promise)
    const clearPromise = () => {
      if (this.connectionPromises.get(sessionId) === promise) {
        this.connectionPromises.delete(sessionId)
      }
    }
    void promise.then(clearPromise, clearPromise)
    return promise
  }

  stop(sessionId: string): void {
    this.intentionalStops.add(sessionId)
    this.clearReconnectTimer(sessionId)
    this.connectionOptions.delete(sessionId)
    const controller = this.controllers.get(sessionId)
    if (controller) {
      controller.abort()
      this.controllers.delete(sessionId)
    }
    this.setState(sessionId, { isConnected: false, isConnecting: false })
  }

  stopAll(): void {
    for (const sessionId of new Set([
      ...this.controllers.keys(),
      ...this.connectionOptions.keys(),
      ...this.reconnectTimers.keys(),
    ])) {
      this.stop(sessionId)
    }
  }

  private async openConnection(sessionId: string, options: ChatTransportOptions): Promise<void> {
    const generation = (this.generations.get(sessionId) ?? 0) + 1
    this.generations.set(sessionId, generation)
    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    this.setState(sessionId, {
      isConnecting: true,
      isConnected: false,
      connectionGeneration: generation,
    })
    logger.info('chat_sse_connect_started', { sessionId, connectionGeneration: generation })

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined
    const method = options.method ?? (body ? 'POST' : 'GET')
    let errorReported = false

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
          logger.info('chat_sse_opened', {
            sessionId,
            connectionGeneration: generation,
            status: response.status,
            contentType: response.headers.get('content-type'),
          })
          if (response.status === 401) {
            this.intentionalStops.add(sessionId)
            this.setState(sessionId, { isConnected: false, isConnecting: false })
            this.handleUnauthorized()
            controller.abort()
            return
          }
          if (!response.ok) {
            // Throwing lets onerror classify 4xx as fatal instead of treating
            // the response as an open SSE stream.
            await apiErrorFromResponse(response)
          }
          if (!this.isCurrent(sessionId, generation, controller)) return
          errorReported = false
          this.setState(sessionId, {
            isConnected: true,
            isConnecting: false,
            reconnectAttempt: 0,
          })
          await options.onopen?.(response)
        },
        onmessage: (msg) => {
          if (!this.isCurrent(sessionId, generation, controller)) return
          logger.debug('chat_sse_event_received', {
            sessionId,
            connectionGeneration: generation,
            event: msg.event,
            dataLength: msg.data.length,
          })
          void options.onmessage?.(msg)
        },
        onerror: (error) => {
          const err = error instanceof Error ? error : new Error(String(error))
          const fatal = this.isFatalError(err)
          const attempt = this.nextReconnectAttempt(sessionId)
          logger.warn('chat_sse_error', {
            sessionId,
            connectionGeneration: generation,
            attempt,
            errorCode: this.errorCode(err),
            fatal,
          })
          if (!errorReported) {
            errorReported = true
            void Promise.resolve(options.onerror?.(err)).catch((callbackError: unknown) => {
              logger.warn('chat_sse_error_callback_failed', {
                sessionId,
                connectionGeneration: generation,
                errorCode: this.errorCode(callbackError),
              })
            })
          }
          if (fatal) {
            this.intentionalStops.add(sessionId)
            throw err
          }
          if (this.intentionalStops.has(sessionId)) {
            throw err
          }
          return this.retryDelay(attempt)
        },
        onclose: () => {
          if (!this.isCurrent(sessionId, generation, controller)) return
          logger.info('chat_sse_closed', {
            sessionId,
            connectionGeneration: generation,
            reason: this.intentionalStops.has(sessionId) ? 'intentional' : 'clean_close',
          })
          this.setState(sessionId, { isConnected: false, isConnecting: false })
          void options.onclose?.()
          if (!this.intentionalStops.has(sessionId)) {
            this.scheduleReconnect(sessionId, options)
          }
        },
      })
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      if (err.name !== 'AbortError' && !errorReported && !this.intentionalStops.has(sessionId)) {
        logger.warn('chat_sse_connect_failed', {
          sessionId,
          connectionGeneration: generation,
          errorCode: this.errorCode(err),
        })
        await options.onerror?.(err)
      }
      if (err.name !== 'AbortError' && !this.isFatalError(err) && !this.intentionalStops.has(sessionId)) {
        this.scheduleReconnect(sessionId, options)
      }
    } finally {
      if (this.controllers.get(sessionId) === controller) {
        this.controllers.delete(sessionId)
        this.setState(sessionId, { isConnected: false, isConnecting: false })
      }
    }
  }

  private isCurrent(sessionId: string, generation: number, controller: AbortController): boolean {
    return this.generations.get(sessionId) === generation && this.controllers.get(sessionId) === controller
  }

  private scheduleReconnect(sessionId: string, options: ChatTransportOptions): void {
    if (this.reconnectTimers.has(sessionId) || this.intentionalStops.has(sessionId)) return
    const attempt = this.nextReconnectAttempt(sessionId)
    const delayMs = this.retryDelay(attempt)
    logger.info('chat_sse_reconnect_scheduled', { sessionId, attempt, delayMs })
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(sessionId)
      if (!this.intentionalStops.has(sessionId)) {
        void this.sendMessages(sessionId, options).catch((error: unknown) => {
          logger.warn('chat_sse_reconnect_failed', {
            sessionId,
            errorCode: this.errorCode(error),
          })
        })
      }
    }, delayMs)
    this.reconnectTimers.set(sessionId, timer)
  }

  private clearReconnectTimer(sessionId: string): void {
    const timer = this.reconnectTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.reconnectTimers.delete(sessionId)
    }
  }

  private nextReconnectAttempt(sessionId: string): number {
    const current = this.getState(sessionId).reconnectAttempt
    const attempt = current + 1
    this.setState(sessionId, { reconnectAttempt: attempt })
    return attempt
  }

  private retryDelay(attempt: number): number {
    const base = Math.min(5000, 250 * (2 ** Math.min(attempt - 1, 5)))
    return base + Math.floor(Math.random() * Math.max(1, Math.floor(base / 4)))
  }

  private isFatalError(error: Error): boolean {
    if (error instanceof ApiError) {
      const status = error.problem.status
      return status >= 400 && status < 500 && status !== 429
    }
    return this.isUnauthorizedError(error)
  }

  private errorCode(error: unknown): string {
    if (error instanceof ApiError) return error.problem.code
    if (error instanceof Error && error.name) return error.name
    return 'SSE_CONNECTION_FAILED'
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
