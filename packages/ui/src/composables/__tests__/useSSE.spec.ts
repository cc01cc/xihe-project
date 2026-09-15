import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { chatTransport } from '@/services/chatTransport'
import { useSSE } from '../useSSE'
import { useAgentStore } from '../../stores/agent'
import { useAuthStore } from '../../stores/auth'
import { useCheckpointStore } from '../../stores/checkpoint'

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REQUEST_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LATE_REQUEST_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const LOGOUT_REQUEST_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const LIVENESS_REQUEST_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'

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
    const { connect } = useSSE(SESSION_ID)
    connect()
    await flushPromises()
    expect(chatTransport.sendMessages).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        url: `/api/v1/events?sessionId=${SESSION_ID}`,
      }),
    )
  })

  it('sets isConnected to true when transport opens', async () => {
    const transport = createTransportController()
    const { connect, isConnected } = useSSE(SESSION_ID)
    connect()
    await flushPromises()
    await transport.simulateOpen()
    expect(isConnected.value).toBe(true)
  })

  it('passes Authorization header from localStorage token', async () => {
    localStorage.setItem('xihe-token', 'my-token')
    const { connect } = useSSE(SESSION_ID)
    connect()
    await flushPromises()
    expect(chatTransport.sendMessages).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        url: `/api/v1/events?sessionId=${SESSION_ID}`,
        headers: { Authorization: 'Bearer my-token' },
      }),
    )
  })

  it('emits tokens via onToken callback', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    const onToken = vi.fn()
    connect({ onToken })
    await flushPromises()
    await transport.simulateMessage('token', JSON.stringify({ content: 'hello' }))
    expect(onToken).toHaveBeenCalledWith('hello', undefined)
  })

  it('does not start content lifecycle before the first token', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    const onStart = vi.fn()
    connect({ onStart })
    await flushPromises()

    await transport.simulateMessage('status', JSON.stringify({ status: 'thinking' }))
    expect(onStart).not.toHaveBeenCalled()

    await transport.simulateMessage('token', JSON.stringify({ content: 'hello' }))
    expect(onStart).toHaveBeenCalledTimes(1)
  })

  it('emits status via onStatus callback', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    const onStatus = vi.fn()
    connect({ onStatus })
    await flushPromises()
    await transport.simulateMessage('status', JSON.stringify({ status: 'executing' }))
    expect(onStatus).toHaveBeenCalledWith('executing')
  })

  it('preserves nested policy evidence on approval requests', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    connect()
    await flushPromises()

    const policy = {
      effect: 'ask',
      sourceLayer: 'workspace',
      matchedRule: null,
      reason: 'No matching allow rule',
      mode: 'default',
      modeAtGrant: 'managed',
      actionClass: 'write',
      shape: 'structured',
    }
    await transport.simulateMessage('approval_request', JSON.stringify({
      requestId: REQUEST_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      tool: 'write_file',
      action: 'write file',
      details: '/README.md',
      snapshotId: null,
      policyClass: 'ask_approval',
      argumentsHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      state: 'pending',
      replayed: true,
      policy,
    }))

    expect(useAgentStore().agentState.pendingApprovals[0]).toMatchObject({
      requestId: REQUEST_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      snapshotId: null,
      policyClass: 'ask_approval',
      argumentsHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      state: 'pending',
      replayed: true,
      policy,
    })
  })

  it('merges run_checkpoint events into the checkpoint store', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    connect()
    await flushPromises()

    await transport.simulateMessage('run_checkpoint', JSON.stringify({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      state: 'sealed',
      changedCount: 5,
      revert: null,
    }))

    const record = useCheckpointStore().get(RUN_ID)
    expect(record?.state).toBe('sealed')
    expect(record?.changedCount).toBe(5)
    expect(record?.sessionId).toBe(SESSION_ID)
  })

  it('drops run_checkpoint events that belong to another session', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    connect()
    await flushPromises()

    await transport.simulateMessage('run_checkpoint', JSON.stringify({
      runId: RUN_ID,
      sessionId: 'some-other-session',
      state: 'sealed',
      changedCount: 5,
    }))

    expect(useCheckpointStore().get(RUN_ID)).toBeUndefined()
  })

  it('drops late approval events after the agent store epoch changes', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    connect()
    await flushPromises()
    useAgentStore().reset()

    await transport.simulateMessage('approval_request', JSON.stringify({
      requestId: LATE_REQUEST_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      tool: 'write_file',
      action: 'write file',
      details: '/README.md',
      state: 'pending',
    }))

    expect(useAgentStore().agentState.pendingApprovals).toEqual([])
  })

  it('drops late approval events after logout cleanup resets the agent store', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    connect()
    await flushPromises()
    useAuthStore().logout()

    await transport.simulateMessage('approval_request', JSON.stringify({
      requestId: LOGOUT_REQUEST_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      tool: 'write_file',
      action: 'write file',
      details: '/README.md',
      state: 'pending',
    }))

    expect(useAgentStore().agentState.pendingApprovals).toEqual([])
  })

  it('emits done via onDone callback and stops streaming flag', async () => {
    const transport = createTransportController()
    const { connect, isStreaming } = useSSE(SESSION_ID)
    const onDone = vi.fn()
    connect({ onDone })
    await flushPromises()
    await transport.simulateMessage('done', '')
    expect(onDone).toHaveBeenCalled()
    expect(isStreaming.value).toBe(false)
  })

  it('emits error via onError callback when connect fails', async () => {
    vi.mocked(chatTransport.sendMessages).mockRejectedValueOnce(new Error('connect failed'))
    const { connect } = useSSE(SESSION_ID)
    const onError = vi.fn()
    connect({ onError })
    await flushPromises()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'SSE_CONNECTION_FAILED',
      detail: 'connect failed',
    }))
  })

  it('does not emit transport retry errors via onError callback', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    const onError = vi.fn()
    connect({ onError })
    await flushPromises()
    await transport.simulateError('network failure')
    await transport.simulateError('network failure')
    expect(onError).not.toHaveBeenCalled()
  })

  it('stops transport on disconnect', () => {
    const { disconnect } = useSSE(SESSION_ID)
    disconnect()
    expect(chatTransport.stop).toHaveBeenCalledWith(SESSION_ID)
  })
})

describe('stream liveness timer (S-1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function startStreamingRun() {
    const transport = createTransportController()
    const sse = useSSE(SESSION_ID)
    const onError = vi.fn()
    const onDone = vi.fn()
    sse.connect({ onError, onDone })
    await flushPromises()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ runId: RUN_ID }),
    }))
    await sse.sendMessage({ content: 'hello' })
    await transport.simulateMessage('token', JSON.stringify({ content: 'hi' }))
    return { transport, sse, onError, onDone }
  }

  it('keeps the run alive across long silent gaps while heartbeats arrive', async () => {
    const { transport, sse, onError } = await startStreamingRun()

    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(25_000)
      await transport.simulateMessage('heartbeat', JSON.stringify({ type: 'heartbeat' }))
    }
    await vi.advanceTimersByTimeAsync(10_000)

    expect(onError).not.toHaveBeenCalled()
    expect(sse.isStreaming.value).toBe(true)
  })

  it('times out as ambiguous when every event stops after content started', async () => {
    const { onError, onDone } = await startStreamingRun()

    await vi.advanceTimersByTimeAsync(31_000)

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AGENT_TIMEOUT',
      outcome: 'ambiguous',
    }))
    expect(onDone).toHaveBeenCalledWith('ambiguous')
  })

  it('times out as error when nothing arrives before the first token', async () => {
    const sse = useSSE(SESSION_ID)
    const onError = vi.fn()
    sse.connect({ onError })
    await flushPromises()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ runId: RUN_ID }),
    }))
    await sse.sendMessage({ content: 'hello' })

    await vi.advanceTimersByTimeAsync(31_000)

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: 'AGENT_TIMEOUT',
      outcome: 'error',
    }))
  })

  it('does not arm the timer while idle', async () => {
    const transport = createTransportController()
    const { connect } = useSSE(SESSION_ID)
    const onError = vi.fn()
    connect({ onError })
    await flushPromises()

    for (let i = 0; i < 4; i += 1) {
      await transport.simulateMessage('heartbeat', JSON.stringify({ type: 'heartbeat' }))
      await vi.advanceTimersByTimeAsync(25_000)
    }

    expect(onError).not.toHaveBeenCalled()
  })

  it('treats tool, approval and status events as liveness signals', async () => {
    const { transport, onError } = await startStreamingRun()
    const events: Array<[string, unknown]> = [
      ['tool_call', { id: 'tool-1', name: 'execute_command', arguments: '{}' }],
      ['tool_result', { id: 'tool-1', result: 'done' }],
      ['approval_request', {
        requestId: LIVENESS_REQUEST_ID,
        runId: RUN_ID,
        sessionId: SESSION_ID,
        workspaceId: WORKSPACE_ID,
        tool: 'request_approval',
        action: 'write file',
        details: '/README.md',
      }],
      ['status', { status: 'executing' }],
    ]

    for (const [name, data] of events) {
      await vi.advanceTimersByTimeAsync(25_000)
      await transport.simulateMessage(name, JSON.stringify(data))
    }
    await vi.advanceTimersByTimeAsync(10_000)

    expect(onError).not.toHaveBeenCalled()
  })
})
