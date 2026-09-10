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
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  async function mockStatus(status: string, extra: Record<string, unknown> = {}) {
    const { api } = await import('../../composables/api')
    vi.mocked(api.getChatRunStatus).mockResolvedValue({
      runId: 'r1', sessionId: 's1', status, leaseExpired: false, pendingApprovals: [], ...extra,
    })
  }

  it('resumed when run awaits approval; replays approvals into agent store', async () => {
    await mockStatus('awaiting_approval', {
      pendingApprovals: [{ requestId: 'req-1', runId: 'r1', sessionId: 's1', tool: 'write_file', action: 'a', details: 'd' }],
    })
    const store = useChatStore()
    await store.refreshRunRecovery('s1', 'r1')
    expect(store.runRecovery['s1']?.state).toBe('resumed')
    const { useAgentStore } = await import('../agent')
    expect(useAgentStore().agentState.pendingApprovals.some((a) => a.requestId === 'req-1')).toBe(true)
  })

  it('resumed when a failed run carries an ambiguous outcome with a pending approval', async () => {
    await mockStatus('failed', {
      terminalOutcome: 'ambiguous',
      pendingApprovals: [{ requestId: 'req-2', runId: 'r1', sessionId: 's1', tool: 'write_file', action: 'a', details: 'd' }],
    })
    const store = useChatStore()
    await store.refreshRunRecovery('s1', 'r1')
    expect(store.runRecovery['s1']?.state).toBe('resumed')
    const { useAgentStore } = await import('../agent')
    expect(useAgentStore().agentState.pendingApprovals.some((a) => a.requestId === 'req-2')).toBe(true)
  })

  it('cancelled for terminal run states', async () => {
    await mockStatus('cancelled')
    const store = useChatStore()
    await store.refreshRunRecovery('s1', 'r1')
    expect(store.runRecovery['s1']?.state).toBe('cancelled')
  })

  it('retry when the lease expired on a running run', async () => {
    await mockStatus('running', { leaseExpired: true })
    const store = useChatStore()
    await store.refreshRunRecovery('s1', 'r1')
    expect(store.runRecovery['s1']?.state).toBe('retry')
  })

  it('sets no banner for succeeded runs', async () => {
    await mockStatus('succeeded')
    const store = useChatStore()
    await store.refreshRunRecovery('s1', 'r1')
    expect(store.runRecovery['s1']).toBeUndefined()
  })

  it('retry when the status query fails', async () => {
    const { api } = await import('../../composables/api')
    vi.mocked(api.getChatRunStatus).mockRejectedValue(new Error('network down'))
    const store = useChatStore()
    await store.refreshRunRecovery('s1', 'r1')
    expect(store.runRecovery['s1']?.state).toBe('retry')
  })

  it('dismissRunRecovery clears the banner', async () => {
    await mockStatus('cancelled')
    const store = useChatStore()
    await store.refreshRunRecovery('s1', 'r1')
    store.dismissRunRecovery('s1')
    expect(store.runRecovery['s1']).toBeUndefined()
  })
})
