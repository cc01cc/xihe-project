/**
 * 测试用例：复现 Xihe 前端的报错
 *
 * 这些测试断言"正确行为"，当前代码有 bug 所以测试应该失败。
 * 修复后这些测试应该通过。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatTransport } from '@/services/chatTransport'
import { useSSE } from '../../composables/useSSE'

vi.mock('@/services/chatTransport', () => ({
  chatTransport: {
    sendMessages: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    getState: vi.fn(() => ({ isConnected: false, isConnecting: false })),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Bug 1: /chat Content-Type mismatch — useSSE 发送 FormData，后端期望 JSON
describe('BUG-1: /chat Content-Type mismatch', () => {
  it('sendMessage should send JSON body, not FormData', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const { sendMessage } = useSSE('test-session')
    await sendMessage({ content: 'Hello world' })

    const [endpoint, options] = fetchSpy.mock.calls[0]
    const body = options.body

    expect(endpoint).toBe('/api/v1/chat')
    expect(body).not.toBeInstanceOf(FormData)
    expect(typeof body).toBe('string')
    const parsed = JSON.parse(body)
    expect(parsed.content).toBe('Hello world')
    expect(parsed.session_id).toBe('test-session')
  })

  it('sendMessage should set Content-Type: application/json', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const { sendMessage } = useSSE('test-session')
    await sendMessage({ content: 'Hello' })

    const [, options] = fetchSpy.mock.calls[0]
    const headers = options.headers || {}
    expect(headers['Content-Type']).toBe('application/json')
  })
})

// Bug 2: /telemetry/logs 404 — 后端没有这个端点
describe('BUG-2: /telemetry/logs 404', () => {
  it('logger.flush should not send to non-existent endpoint', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    vi.stubGlobal('fetch', fetchSpy)

    const { logger } = await import('../../lib/logger')
    logger.info('test message')
    await logger.flush()

    if (fetchSpy.mock.calls.length > 0) {
      const [endpoint] = fetchSpy.mock.calls[0]
      expect(endpoint).not.toBe('/api/v1/telemetry/logs')
    }
  })
})

// Bug 3: /events SSE connection — token 改由 Authorization header 传递
describe('BUG-3: /events SSE connection', () => {
  it('SSE connection should send token via Authorization header', async () => {
    localStorage.setItem('xihe-token', 'test-jwt-token')

    const { connect } = useSSE('test-session')
    connect()

    expect(vi.mocked(chatTransport.sendMessages)).toHaveBeenCalledWith(
      'test-session',
      expect.objectContaining({
        url: '/api/v1/events?session_id=test-session',
        headers: { Authorization: 'Bearer test-jwt-token' },
      }),
    )
  })
})

// Bug 4: attachments 必须以 fileId[] 形式随 /chat JSON 发送
describe('BUG-4: attachments must be sent as fileId array', () => {
  it('sendMessage with attachments should send JSON with fileIds', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchSpy)

    const { sendMessage } = useSSE('test-session')
    await sendMessage({ content: 'Analyze this', attachments: ['file-id-1'] })

    const [, options] = fetchSpy.mock.calls[0]
    const body = options.body

    expect(body).not.toBeInstanceOf(FormData)
    expect(typeof body).toBe('string')
    const parsed = JSON.parse(body)
    expect(parsed.content).toBe('Analyze this')
    expect(parsed.session_id).toBe('test-session')
    expect(parsed.stream).toBe(true)
    expect(parsed.attachments).toEqual(['file-id-1'])
  })
})

// Bug 5: /chat 502 — error handling
describe('BUG-5: /chat 502 error handling', () => {
  it('sendMessage should handle 502 and set error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false, status: 502,
      json: () => Promise.resolve({ error: 'Bad Gateway' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { sendMessage, error } = useSSE('test-session')
    await sendMessage({ content: 'Hello' })

    expect(error.value).toContain('502')
  })
})

// Bug 6: /chat 409 — SSE disconnected then sendMessage returns 409,
//        but onError callback is not invoked and isStreaming stays true.
describe('BUG-6: /chat 409 when SSE subscription is missing', () => {
  it('sendMessage should surface 409 error via onError callback from connect', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ message: 'No active SSE subscription for session' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const onError = vi.fn()
    const { connect, sendMessage, error } = useSSE('test-session')
    connect({ onError })
    await sendMessage({ content: 'Hello' })

    expect(error.value).toBe('No active SSE subscription for session')
    expect(onError).toHaveBeenCalledWith('No active SSE subscription for session')
  })

  it('sendMessage should reset streaming state on 409', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ message: 'No active SSE subscription for session' }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { sendMessage, isStreaming } = useSSE('test-session')
    await sendMessage({ content: 'Hello' })

    expect(isStreaming.value).toBe(false)
  })
})
