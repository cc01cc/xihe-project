import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError, api } from '../../composables/api'
import { useAgentStore } from '../agent'
import type { ApprovalRequest } from '../../types'

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_WORKSPACE_REQUEST_ID = '33333333-3333-4333-8333-333333333333'
const DISPATCHING_REQUEST_ID = '44444444-4444-4444-8444-444444444444'
const UNKNOWN_REQUEST_ID = '55555555-5555-4555-8555-555555555555'
const EXPIRED_REQUEST_ID = '66666666-6666-4666-8666-666666666666'
const RUN_ID = '77777777-7777-4777-8777-777777777777'
const SESSION_ID = '88888888-8888-4888-8888-888888888888'
const OTHER_SESSION_ID = '99999999-9999-4999-8999-999999999999'
const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_WORKSPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      decideChatApproval: vi.fn(),
      getPendingApprovals: vi.fn(),
    },
  }
})

const approval: ApprovalRequest = {
  requestId: REQUEST_ID,
  runId: RUN_ID,
  sessionId: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  tool: 'write_file',
  action: 'write file',
  details: '/README.md',
  state: 'pending',
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.getPendingApprovals).mockResolvedValue([])
})

describe('useAgentStore approval state', () => {
  it('keeps endpoint summaries separate from full approval requests', async () => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    vi.mocked(api.getPendingApprovals).mockResolvedValue([{
       sessionId: SESSION_ID,
       workspaceId: WORKSPACE_ID,
      count: 2,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])

    await store.refreshPendingApprovals()

    expect(store.agentState.pendingApprovals).toEqual([approval])
    expect(store.pendingApprovalSummaries).toEqual([{
       sessionId: SESSION_ID,
       workspaceId: WORKSPACE_ID,
      count: 2,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])
    expect(store.pendingApprovalCount(SESSION_ID)).toBe(2)
    expect(store.pendingApprovalTotal).toBe(2)
  })

  it('refreshes summaries with error-safe last-known state', async () => {
    const store = useAgentStore()
    store.pendingApprovalSummaries = [{
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }]
    vi.mocked(api.getPendingApprovals).mockRejectedValue(new Error('network down'))

    await store.refreshPendingApprovals()

    expect(store.pendingApprovalSummaries).toHaveLength(1)
    expect(store.pendingApprovalsError).toBe('network down')
  })

  it('reconciles full requests when an authoritative summary reports no pending sessions', async () => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    vi.mocked(api.getPendingApprovals).mockResolvedValue([])

    await store.refreshPendingApprovals()

    expect(store.agentState.pendingApprovals).toEqual([])
    expect(store.resolvedApprovals[approval.requestId]).toMatchObject({
      requestId: approval.requestId,
      state: 'dispatch_unknown',
    })
    store.addApprovalRequest(approval)
    expect(store.agentState.pendingApprovals).toEqual([])
  })

  it('reconciles a session explicitly reported with a zero pending count', async () => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    vi.mocked(api.getPendingApprovals).mockResolvedValue([{
      sessionId: approval.sessionId,
      workspaceId: approval.workspaceId!,
      count: 0,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])

    await store.refreshPendingApprovals()

    expect(store.agentState.pendingApprovals).toEqual([])
  })

  it('preserves dispatch_unknown while the authoritative actionable count is nonzero', async () => {
    const store = useAgentStore()
    const retryable = { ...approval, state: 'dispatch_unknown' as const }
    store.addApprovalRequest(retryable)
    vi.mocked(api.getPendingApprovals).mockResolvedValue([{
      sessionId: retryable.sessionId,
      workspaceId: retryable.workspaceId!,
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])

    await store.refreshPendingApprovals()

    expect(store.agentState.pendingApprovals).toEqual([retryable])
  })

  it('ignores an in-flight summary response after clearing one session', async () => {
    const store = useAgentStore()
    const other = { ...approval, requestId: SECOND_REQUEST_ID, sessionId: OTHER_SESSION_ID }
    store.addApprovalRequest(approval)
    store.addApprovalRequest(other)
    store.pendingApprovalSummaries = [{
      sessionId: other.sessionId,
      workspaceId: other.workspaceId!,
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }]
    let resolveSummary: ((summaries: typeof store.pendingApprovalSummaries) => void) | undefined
    vi.mocked(api.getPendingApprovals).mockImplementationOnce(() => new Promise((resolve) => {
      resolveSummary = resolve
    }))

    const pending = store.refreshPendingApprovals()
    store.clearSession(approval.sessionId)
    resolveSummary?.([
      {
        sessionId: approval.sessionId,
        workspaceId: approval.workspaceId!,
        count: 1,
        oldestRequestedAt: '2026-09-14T12:00:00Z',
      },
      {
        sessionId: other.sessionId,
        workspaceId: other.workspaceId!,
        count: 1,
        oldestRequestedAt: '2026-09-14T12:00:00Z',
      },
    ])
    await pending

    expect(store.agentState.pendingApprovals).toEqual([other])
    expect(store.pendingApprovalSummaries).toEqual([{
      sessionId: other.sessionId,
      workspaceId: other.workspaceId,
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])
    expect(store.resolvedApprovals[approval.requestId]).toBeUndefined()
  })

  it('reconciles only the active workspace scope', async () => {
    const store = useAgentStore()
    const otherWorkspace = {
      ...approval,
       requestId: OTHER_WORKSPACE_REQUEST_ID,
       sessionId: OTHER_SESSION_ID,
       workspaceId: OTHER_WORKSPACE_ID,
    }
    store.addApprovalRequest(approval)
    store.addApprovalRequest(otherWorkspace)
    vi.mocked(api.getPendingApprovals).mockResolvedValue([])

    await store.refreshPendingApprovals(false, WORKSPACE_ID)

    expect(store.agentState.pendingApprovals).toEqual([otherWorkspace])
  })

  it.each([401, 403])('clears requests and summaries on authorization failure %s', async (status) => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    store.pendingApprovalSummaries = [{
      sessionId: approval.sessionId,
      workspaceId: approval.workspaceId!,
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }]
    vi.mocked(api.getPendingApprovals).mockRejectedValue(new ApiError({
      status,
      code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
      detail: 'Forbidden',
      requestId: `req-${status}`,
    }))

    await store.refreshPendingApprovals()

    expect(store.agentState.pendingApprovals).toEqual([])
    expect(store.pendingApprovalSummaries).toEqual([])
    expect(store.resolvedApprovals).toEqual({})
  })

  it('aborts an in-flight pending poll without overlapping a second request', async () => {
    const store = useAgentStore()
    vi.mocked(api.getPendingApprovals).mockImplementation((signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))

    const pending = store.refreshPendingApprovals()
    expect(store.pendingApprovalsLoading).toBe(true)
    store.abortPendingRefresh()
    await pending

    expect(store.pendingApprovalsLoading).toBe(false)
    expect(api.getPendingApprovals).toHaveBeenCalledTimes(1)
  })

  it('does not wait for a stalled forced refresh after a successful decision', async () => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    vi.mocked(api.decideChatApproval).mockResolvedValue({
      status: 'accepted',
      requestId: approval.requestId,
      approved: true,
      decision: 'once',
    })
    vi.mocked(api.getPendingApprovals).mockImplementation((signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))

    const response = await Promise.race([
      store.decideApproval(approval.requestId, { decision: 'once' }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('decision timed out')), 100)),
    ])
    expect(response.status).toBe('accepted')
    store.abortPendingRefresh()
  })

  it('submits a structured decision once and removes the resolved request', async () => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
     store.addApprovalRequest({ ...approval, requestId: SECOND_REQUEST_ID, details: '/package.json' })
    vi.mocked(api.decideChatApproval).mockResolvedValue({
      status: 'accepted',
      requestId: approval.requestId,
      approved: true,
      decision: 'session',
      propagated: 1,
    })

    const response = await store.decideApproval(approval.requestId, { decision: 'session' })

    expect(api.decideChatApproval).toHaveBeenCalledTimes(1)
    expect(api.decideChatApproval).toHaveBeenCalledWith(approval.requestId, { decision: 'session' })
    expect(response.propagated).toBe(1)
    expect(store.agentState.pendingApprovals).toEqual([])
    expect(store.resolvedApprovals[approval.requestId]?.state).toBe('approved')
  })

  it('does not reinsert a locally resolved request from a late replay', async () => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    vi.mocked(api.decideChatApproval).mockResolvedValue({
      status: 'accepted',
      requestId: approval.requestId,
      approved: true,
      decision: 'once',
    })

    await store.decideApproval(approval.requestId, { decision: 'once' })
    store.addApprovalRequest({ ...approval, replayed: true, state: 'pending' })
    store.addApprovalRequest({ ...approval, state: 'dispatching' })

    expect(store.agentState.pendingApprovals).toEqual([])
    expect(store.resolvedApprovals[approval.requestId]?.state).toBe('approved')
  })

  it('queues dispatch_unknown for retry while keeping dispatching non-actionable', () => {
    const store = useAgentStore()
    store.addApprovalRequest({ ...approval, requestId: DISPATCHING_REQUEST_ID, state: 'dispatching' })
    store.addApprovalRequest({ ...approval, requestId: UNKNOWN_REQUEST_ID, state: 'dispatch_unknown' })

    expect(store.agentState.pendingApprovals).toHaveLength(1)
    expect(store.agentState.pendingApprovals[0]).toMatchObject({
      requestId: UNKNOWN_REQUEST_ID,
      state: 'dispatch_unknown',
    })
    expect(store.resolvedApprovals[DISPATCHING_REQUEST_ID]?.state).toBe('dispatching')
    expect(store.resolvedApprovals[UNKNOWN_REQUEST_ID]).toBeUndefined()
  })

  it('reopens a dispatching tombstone only when CP reports dispatch_unknown', () => {
    const store = useAgentStore()
    store.addApprovalRequest({ ...approval, requestId: UNKNOWN_REQUEST_ID, state: 'dispatching' })
    store.addApprovalRequest({ ...approval, requestId: UNKNOWN_REQUEST_ID, state: 'dispatch_unknown' })

    expect(store.agentState.pendingApprovals).toMatchObject([{ requestId: UNKNOWN_REQUEST_ID, state: 'dispatch_unknown' }])
    expect(store.resolvedApprovals[UNKNOWN_REQUEST_ID]).toBeUndefined()
  })

  it('preserves an explicit terminal state and request identity', () => {
    const store = useAgentStore()
     store.addApprovalRequest({ ...approval, requestId: EXPIRED_REQUEST_ID, state: 'expired' })

    expect(store.agentState.pendingApprovals).toEqual([])
     expect(store.resolvedApprovals[EXPIRED_REQUEST_ID]).toMatchObject({ requestId: EXPIRED_REQUEST_ID, state: 'expired' })
  })

  it('deduplicates an in-flight decision and preserves the request on a conflict', async () => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    vi.mocked(api.decideChatApproval).mockRejectedValue(new ApiError({
      status: 409,
      code: 'APPROVAL_DECISION_IN_PROGRESS',
      detail: 'Decision is already being dispatched',
      requestId: 'req-1',
    }))

    const first = store.decideApproval(approval.requestId, { decision: 'once' })
    const second = store.decideApproval(approval.requestId, { decision: 'once' })
    const results = await Promise.allSettled([first, second])
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(results[0]?.reason).toMatchObject({ problem: { code: 'APPROVAL_DECISION_IN_PROGRESS' } })

    expect(api.decideChatApproval).toHaveBeenCalledTimes(1)
    expect(store.agentState.pendingApprovals).toEqual([approval])
  })

  it('clears full requests and summaries when a session is deleted', () => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    store.pendingApprovalSummaries = [{
       sessionId: SESSION_ID,
       workspaceId: WORKSPACE_ID,
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }]

     store.clearSession(SESSION_ID)

    expect(store.agentState.pendingApprovals).toEqual([])
    expect(store.pendingApprovalSummaries).toEqual([])
  })

  it('resets approval state on user cleanup', () => {
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    store.pendingApprovalSummaries = [{
       sessionId: SESSION_ID,
       workspaceId: WORKSPACE_ID,
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }]

    store.reset()

    expect(store.agentState.pendingApprovals).toEqual([])
    expect(store.pendingApprovalSummaries).toEqual([])
    expect(store.pendingApprovalTotal).toBe(0)
  })
})
