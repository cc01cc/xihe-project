import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../chat'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getChatRunStatus: vi.fn(),
    },
  }
})

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('useChatStore', () => {
  it('getMessages returns empty array for unknown session', () => {
    const store = useChatStore()
    expect(store.getMessages('nonexistent')).toEqual([])
  })

  it('addMessage stores a message for a session', () => {
    const store = useChatStore()
    const msg = {
      id: 'm1', sessionId: 's1', role: 'user' as const,
      content: 'hello', timestamp: new Date().toISOString(),
    }
    store.addMessage('s1', msg)
    expect(store.getMessages('s1')).toHaveLength(1)
    expect(store.getMessages('s1')[0].content).toBe('hello')
  })

  it('addMessage appends to existing messages', () => {
    const store = useChatStore()
    store.addMessage('s1', {
      id: 'm1', sessionId: 's1', role: 'user' as const,
      content: 'first', timestamp: '2024-01-01',
    })
    store.addMessage('s1', {
      id: 'm2', sessionId: 's1', role: 'assistant' as const,
      content: 'second', timestamp: '2024-01-01',
    })
    expect(store.getMessages('s1')).toHaveLength(2)
  })

  it('createStreamingMessage adds assistant message and tracks it', () => {
    const store = useChatStore()
    const id = store.createStreamingMessage('s1')
    const msgs = store.getMessages('s1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].id).toBe(id)
    expect(msgs[0].isStreaming).toBe(true)
    expect(store.getStreamingMessageId('s1')).toBe(id)
    expect(store.isStreaming('s1')).toBe(true)
  })

  it('keeps streaming and run state scoped to each session', () => {
    const store = useChatStore()
    store.setSessionRunState('session-a', 'awaiting_approval', 'run-a')

    expect(store.isStreaming('session-a')).toBe(true)
    expect(store.getSessionRunId('session-a')).toBe('run-a')
    expect(store.isStreaming('session-b')).toBe(false)
    expect(store.getSessionRunState('session-b').status).toBe('idle')
  })

  it('upsertToolCall creates the live assistant message and merges by id', () => {
    const store = useChatStore()
    store.upsertToolCall('s1', {
      id: 'tc-1',
      name: 'run_command',
      arguments: '{}',
      status: 'running',
    })

    let calls = store.getMessages('s1')[0].toolCalls
    expect(store.getMessages('s1')).toHaveLength(1)
    expect(store.getStreamingMessageId('s1')).toBe(store.getMessages('s1')[0].id)
    expect(calls?.[0]).toMatchObject({ id: 'tc-1', name: 'run_command', status: 'running' })

    store.upsertToolCall('s1', {
      id: 'tc-1',
      status: 'completed',
      result: 'src/a.ts:1:2: error: bad',
      diagnostics: {
        items: [
          {
            file: 'src/a.ts',
            line: 1,
            column: 2,
            severity: 'error',
            kind: 'compile',
            message: 'bad',
            confidence: 'high',
          },
        ],
        total: 1,
        confidence: 'high',
      },
    })

    calls = store.getMessages('s1')[0].toolCalls
    expect(calls).toHaveLength(1)
    expect(calls?.[0]).toMatchObject({
      id: 'tc-1',
      name: 'run_command',
      status: 'completed',
      result: 'src/a.ts:1:2: error: bad',
    })
    expect(calls?.[0].diagnostics?.total).toBe(1)
  })

  it('upsertToolCall keeps tool calls after finalizeStreaming', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.upsertToolCall('s1', { id: 'tc-1', name: 'run_command', arguments: '{}', status: 'running' })
    store.finalizeStreaming('s1')

    const message = store.getMessages('s1')[0]
    expect(message.isStreaming).toBe(false)
    expect(message.toolCalls).toHaveLength(1)
    expect(message.toolCalls?.[0].id).toBe('tc-1')
  })

  it('upsertToolCall reuses the active streaming message instead of creating a second', () => {
    const store = useChatStore()
    const messageId = store.createStreamingMessage('s1', 'run-1')
    store.upsertToolCall('s1', { id: 'tc-1', name: 'run_command', arguments: '{}', status: 'running' })

    expect(store.getMessages('s1')).toHaveLength(1)
    expect(store.getMessages('s1')[0].id).toBe(messageId)
    expect(store.getStreamingMessageId('s1')).toBe(messageId)
  })

  it('keeps a tool-only message when the stream fails', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.upsertToolCall('s1', {
      id: 'tc-1',
      name: 'run_command',
      arguments: '{}',
      status: 'failed',
      error: 'boom',
    })
    store.markStreamingError('s1', {
      code: 'AGENT_STREAM_FAILED',
      detail: 'stream failed',
      outcome: 'error',
    })

    const message = store.getMessages('s1')[0]
    expect(message.toolCalls).toHaveLength(1)
    expect(message.runStatus).toBe('failed')
    expect(message.terminalOutcome).toBe('error')
    expect(store.isStreaming('s1')).toBe(false)
  })

  it('loadMessages does not replace an in-flight streaming message', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'text', content: 'partial' })

    store.loadMessages('s1', [{
      id: 'server-user',
      sessionId: 's1',
      role: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    }])

    expect(store.getMessages('s1')[0].parts).toEqual([{ type: 'text', content: 'partial' }])
    expect(store.isStreaming('s1')).toBe(true)
  })

  it('appendToParts appends text parts to streaming message content', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'text', content: 'Hel' })
    store.appendToParts('s1', { type: 'text', content: 'lo' })
    expect(store.getMessages('s1')[0].parts).toHaveLength(1)
    expect(store.getMessages('s1')[0].parts![0]).toEqual({ type: 'text', content: 'Hello' })
  })

  it('appendToParts appends reasoning parts separately', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'reasoning', content: '思考中' })
    store.appendToParts('s1', { type: 'text', content: '答案' })
    const parts = store.getMessages('s1')[0].parts!
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'reasoning', content: '思考中' })
    expect(parts[1]).toEqual({ type: 'text', content: '答案' })
  })

  it('appendToParts merges consecutive same-type parts', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'text', content: 'A' })
    store.appendToParts('s1', { type: 'text', content: 'B' })
    expect(store.getMessages('s1')[0].parts).toHaveLength(1)
    expect(store.getMessages('s1')[0].parts![0].content).toBe('AB')
  })

  it('replaceStreamingParts updates the live parser result', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.replaceStreamingParts('s1', [{ type: 'text', content: 'A' }])
    expect(store.getMessages('s1')[0].parts).toEqual([{ type: 'text', content: 'A' }])

    store.replaceStreamingParts('s1', [{ type: 'text', content: 'AB' }])
    expect(store.getMessages('s1')[0].parts).toEqual([{ type: 'text', content: 'AB' }])
  })

  it('appendToParts does nothing when no streaming message exists', () => {
    const store = useChatStore()
    store.appendToParts('s1', { type: 'text', content: 'orphan' })
    expect(store.getMessages('s1')).toEqual([])
  })

  it('finalizeStreaming marks streaming message as completed', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'text', content: 'streamed content' })
    store.finalizeStreaming('s1')
    const msgs = store.getMessages('s1')
    expect(msgs[0].content).toBe('streamed content')
    expect(msgs[0].isStreaming).toBe(false)
    expect(store.isStreaming('s1')).toBe(false)
  })

  it('finalizeStreaming merges parts into content', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'reasoning', content: '思考' })
    store.appendToParts('s1', { type: 'text', content: '答案' })
    store.finalizeStreaming('s1')
    expect(store.getMessages('s1')[0].content).toBe('答案')
  })

  it('finalizeStreaming does nothing when no streaming message exists', () => {
    const store = useChatStore()
    store.finalizeStreaming('s1')
    expect(store.getMessages('s1')).toEqual([])
  })

  it('interruptForOverflowRetry keeps visible content as interrupted (case B)', () => {
    // PLAN-0341 U3: retry is the official reply; prior content is folded.
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'text', content: 'partial answer before overflow' })
    store.interruptForOverflowRetry('s1')

    const messages = store.getMessages('s1')
    const assistant = messages.find((m) => m.role === 'assistant')
    expect(assistant?.interrupted).toBe(true)
    expect(assistant?.runStatus).toBe('interrupted')
    expect(assistant?.content).toContain('partial answer before overflow')
    expect(messages.some((m) => m.marker === 'status' && m.status === 'interrupted')).toBe(true)
    expect(store.isStreaming('s1')).toBe(false)
  })

  it('interruptForOverflowRetry drops empty streaming bubble (case A)', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.interruptForOverflowRetry('s1')
    expect(store.getMessages('s1').filter((m) => m.role === 'assistant')).toEqual([])
  })

  it('removes an empty assistant when the stream fails', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.markStreamingError('s1', {
      code: 'LLM_CREDENTIALS_INVALID',
      detail: 'Provider credentials were rejected',
      retryable: true,
      outcome: 'error',
    })
    expect(store.getMessages('s1')).toEqual([])
    expect(store.isStreaming('s1')).toBe(false)
  })

  it('preserves ambiguous terminal state for partial content', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'text', content: 'possibly charged' })
    store.markStreamingError('s1', {
      code: 'AGENT_TIMEOUT',
      detail: 'Provider result is uncertain',
      retryable: false,
      outcome: 'ambiguous',
    })
    const message = store.getMessages('s1')[0]
    expect(message.runStatus).toBe('ambiguous')
    expect(message.terminalOutcome).toBe('ambiguous')
    expect(message.retryable).toBe(false)
  })

  it('clearSession removes all data for a session', () => {
    const store = useChatStore()
    store.addMessage('s1', {
      id: 'm1', sessionId: 's1', role: 'user' as const,
      content: 'x', timestamp: '2024-01-01',
    })
    store.createStreamingMessage('s1')
    store.clearSession('s1')
    expect(store.getMessages('s1')).toEqual([])
    expect(store.getStreamingMessageId('s1')).toBeNull()
    expect(store.isStreaming('s1')).toBe(false)
  })

  it('clearAllData clears auth-only localStorage keys and resets in-memory messages', () => {
    localStorage.setItem('xihe-token', 'abc')
    localStorage.setItem('xihe-workspace', JSON.stringify({ id: 'ws-1' }))
    const store = useChatStore()
    store.addMessage('s1', {
      id: 'm1',
      sessionId: 's1',
      role: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    })
    store.clearAllData()
    expect(localStorage.getItem('xihe-token')).toBeNull()
    expect(localStorage.getItem('xihe-workspace')).toBeNull()
    expect(store.getMessages('s1')).toEqual([])
  })
})

describe('refreshRunRecovery tri-state (PLAN-292 M3 C2/C3)', () => {
  const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const NEW_RUN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const OLD_RUN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  const REQUEST_ID_1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  const REQUEST_ID_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const TERMINAL_REQUEST_ID = '99999999-9999-4999-8999-999999999999'

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  async function mockStatus(status: string, extra: Record<string, unknown> = {}) {
    const { api } = await import('../../composables/api')
    vi.mocked(api.getChatRunStatus).mockResolvedValue({
      runId: RUN_ID, sessionId: SESSION_ID, status, leaseExpired: false, pendingApprovals: [], ...extra,
    })
  }

  it('resumed when run awaits approval; replays approvals into agent store', async () => {
    await mockStatus('awaiting_approval', {
      pendingApprovals: [{ requestId: REQUEST_ID_1, runId: RUN_ID, sessionId: SESSION_ID, tool: 'write_file', action: 'a', details: 'd' }],
    })
    const store = useChatStore()
    await store.refreshRunRecovery(SESSION_ID, RUN_ID)
    expect(store.runRecovery[SESSION_ID]?.state).toBe('resumed')
    const { useAgentStore } = await import('../agent')
    expect(useAgentStore().agentState.pendingApprovals.some((a) => a.requestId === REQUEST_ID_1)).toBe(true)
  })

  it('resumed when a failed run carries an ambiguous outcome with a pending approval', async () => {
    await mockStatus('failed', {
      terminalOutcome: 'ambiguous',
      pendingApprovals: [{ requestId: REQUEST_ID_2, runId: RUN_ID, sessionId: SESSION_ID, tool: 'write_file', action: 'a', details: 'd' }],
    })
    const store = useChatStore()
    await store.refreshRunRecovery(SESSION_ID, RUN_ID)
    expect(store.runRecovery[SESSION_ID]?.state).toBe('resumed')
    const { useAgentStore } = await import('../agent')
    expect(useAgentStore().agentState.pendingApprovals.some((a) => a.requestId === REQUEST_ID_2)).toBe(true)
  })

  it('cancelled for terminal run states', async () => {
    await mockStatus('cancelled')
    const store = useChatStore()
    await store.refreshRunRecovery(SESSION_ID, RUN_ID)
    expect(store.runRecovery[SESSION_ID]?.state).toBe('cancelled')
  })

  it('retry when the lease expired on a running run', async () => {
    await mockStatus('running', { leaseExpired: true })
    const store = useChatStore()
    await store.refreshRunRecovery(SESSION_ID, RUN_ID)
    expect(store.runRecovery[SESSION_ID]?.state).toBe('retry')
  })

  it('sets no banner for succeeded runs', async () => {
    await mockStatus('succeeded')
    const store = useChatStore()
    await store.refreshRunRecovery(SESSION_ID, RUN_ID)
    expect(store.runRecovery[SESSION_ID]).toBeUndefined()
  })

  it('retry when the status query fails', async () => {
    const { api } = await import('../../composables/api')
    vi.mocked(api.getChatRunStatus).mockRejectedValue(new Error('network down'))
    const store = useChatStore()
    await store.refreshRunRecovery(SESSION_ID, RUN_ID)
    expect(store.runRecovery[SESSION_ID]?.state).toBe('retry')
  })

  it('ignores a stale recovery response for an older run', async () => {
    const { api } = await import('../../composables/api')
    let resolveOld: ((value: {
      runId: string
      sessionId: string
      status: string
      leaseExpired: boolean
      pendingApprovals: never[]
    }) => void) | undefined
    vi.mocked(api.getChatRunStatus)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce({
        runId: NEW_RUN_ID,
        sessionId: SESSION_ID,
        status: 'cancelled',
        leaseExpired: false,
        pendingApprovals: [],
      })
    const store = useChatStore()
    const oldRequest = store.refreshRunRecovery(SESSION_ID, OLD_RUN_ID)
    const newRequest = store.refreshRunRecovery(SESSION_ID, NEW_RUN_ID)
    await newRequest
    resolveOld?.({
      runId: OLD_RUN_ID,
      sessionId: SESSION_ID,
      status: 'awaiting_approval',
      leaseExpired: false,
      pendingApprovals: [],
    })
    await oldRequest

    expect(store.runRecovery[SESSION_ID]).toMatchObject({ runId: NEW_RUN_ID, state: 'cancelled' })
  })

  it('ignores a recovery response invalidated by a completed decision', async () => {
    const { api } = await import('../../composables/api')
    let resolveStatus: ((value: {
      runId: string
      sessionId: string
      status: string
      leaseExpired: boolean
      pendingApprovals: never[]
    }) => void) | undefined
    vi.mocked(api.getChatRunStatus).mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve }))
    const store = useChatStore()
    const pending = store.refreshRunRecovery(SESSION_ID, RUN_ID)
    store.invalidateRunRecovery(SESSION_ID, RUN_ID)
    resolveStatus?.({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      status: 'awaiting_approval',
      leaseExpired: false,
      pendingApprovals: [],
    })
    await pending

    expect(store.runRecovery[SESSION_ID]).toBeUndefined()
    expect(store.getSessionRunState(SESSION_ID).status).toBe('idle')
  })

  it('keeps terminal recovery from resurrecting approvals for the run', async () => {
    const { useAgentStore } = await import('../agent')
    const agent = useAgentStore()
    agent.addApprovalRequest({
      requestId: TERMINAL_REQUEST_ID,
      runId: RUN_ID,
      sessionId: SESSION_ID,
      tool: 'write_file',
      action: 'write',
      details: 'd',
      state: 'pending',
    })
    await mockStatus('succeeded')
    const store = useChatStore()
    await store.refreshRunRecovery(SESSION_ID, RUN_ID)

    expect(agent.agentState.pendingApprovals).toEqual([])
    expect(agent.resolvedApprovals[TERMINAL_REQUEST_ID]?.state).toBe('dispatch_unknown')
  })

  it('dismissRunRecovery clears the banner', async () => {
    await mockStatus('cancelled')
    const store = useChatStore()
    await store.refreshRunRecovery(SESSION_ID, RUN_ID)
    store.dismissRunRecovery(SESSION_ID)
    expect(store.runRecovery[SESSION_ID]).toBeUndefined()
  })
})
