import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { chatTransport } from '@/services/chatTransport'
import { useSSE } from '../useSSE'

vi.mock('@/services/chatTransport', () => ({
  chatTransport: {
    sendMessages: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getState: vi.fn(() => ({ isConnected: false, isConnecting: false })),
  },
}))

function createTransportController() {
  let onopen: ((response: Response) => void | Promise<void>) | undefined
  let onmessage: ((event: { event: string; data: string; id?: string }) => void | Promise<void>) | undefined
  let onerror: ((error: Error) => void | Promise<void>) | undefined
  let onclose: (() => void | Promise<void>) | undefined

  vi.mocked(chatTransport.sendMessages).mockImplementation((_sessionId: string, options: {
    onopen?: typeof onopen
    onmessage?: typeof onmessage
    onerror?: typeof onerror
    onclose?: typeof onclose
  }) => {
    onopen = options.onopen
    onmessage = options.onmessage
    onerror = options.onerror
    onclose = options.onclose
    return Promise.resolve()
  })

  return {
    get handlers() {
      return { onopen, onmessage, onerror, onclose }
    },
    simulateOpen(response = new Response(null, { status: 200 })) {
      return onopen?.(response)
    },
    simulateMessage(event: string, data: string) {
      return onmessage?.({ event, data })
    },
    simulateError(message: string) {
      return onerror?.(new Error(message))
    },
    simulateClose() {
      return onclose?.()
    },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(chatTransport.sendMessages).mockClear()
  vi.mocked(chatTransport.stop).mockClear()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useSSE', () => {
  it('connect calls chatTransport.sendMessages with correct URL and session id', async () => {
    const { connect } = useSSE('test-session-id')
    connect()
    await flushPromises()
    expect(chatTransport.sendMessages).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({
        url: '/api/v1/events?session_id=test-session-id',
      }),
    )
  })

  it('sets isConnected to true when transport opens', async () => {
    const transport = createTransportController()
    const { connect, isConnected } = useSSE('test-session-id')
    connect()
    await flushPromises()
    await transport.simulateOpen()
    expect(isConnected.value).toBe(true)
  })

  it('passes Authorization header from localStorage token', async () => {
    localStorage.setItem('xihe-token', 'my-token')
    const { connect } = useSSE('test-session-id')
    connect()
    await flushPromises()
    expect(chatTransport.sendMessages).toHaveBeenCalledWith(
      'test-session-id',
      expect.objectContaining({
        url: '/api/v1/events?session_id=test-session-id&token=my-token',
        headers: { Authorization: 'Bearer my-token' },
      }),
    )
  })

  it('emits tokens via onToken callback', async () => {
    const transport = createTransportController()
    const { connect } = useSSE('test-session-id')
    const onToken = vi.fn()
    connect({ onToken })
    await flushPromises()
    await transport.simulateMessage('token', JSON.stringify({ content: 'hello' }))
    expect(onToken).toHaveBeenCalledWith('hello', undefined)
  })

  it('emits status via onStatus callback', async () => {
    const transport = createTransportController()
    const { connect } = useSSE('test-session-id')
    const onStatus = vi.fn()
    connect({ onStatus })
    await flushPromises()
    await transport.simulateMessage('status', JSON.stringify({ status: 'executing' }))
    expect(onStatus).toHaveBeenCalledWith('executing')
  })

  it('emits done via onDone callback and stops streaming flag', async () => {
    const transport = createTransportController()
    const { connect, isStreaming } = useSSE('test-session-id')
    const onDone = vi.fn()
    connect({ onDone })
    await flushPromises()
    await transport.simulateMessage('done', '')
    expect(onDone).toHaveBeenCalled()
    expect(isStreaming.value).toBe(false)
  })

  it('emits error via onError callback when connect fails', async () => {
    vi.mocked(chatTransport.sendMessages).mockRejectedValueOnce(new Error('connect failed'))
    const { connect } = useSSE('test-session-id')
    const onError = vi.fn()
    connect({ onError })
    await flushPromises()
    expect(onError).toHaveBeenCalledWith('connect failed')
  })

  it('does not emit transport retry errors via onError callback', async () => {
    const transport = createTransportController()
    const { connect } = useSSE('test-session-id')
    const onError = vi.fn()
    connect({ onError })
    await flushPromises()
    await transport.simulateError('network failure')
    await transport.simulateError('network failure')
    expect(onError).not.toHaveBeenCalled()
  })

  it('stops transport on disconnect', () => {
    const { disconnect } = useSSE('test-session-id')
    disconnect()
    expect(chatTransport.stop).toHaveBeenCalledWith('test-session-id')
  })
})
