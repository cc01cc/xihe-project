import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useCheckpointStore } from '../checkpoint'
import { ApiError, api } from '../../composables/api'
import type { RunCheckpointView } from '../../types'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getRunCheckpoint: vi.fn(),
    },
  }
})

const mockedApi = vi.mocked(api, true)

const RUN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const RUN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SESSION_A = '11111111-1111-4111-8111-111111111111'
const SESSION_B = '22222222-2222-4222-8222-222222222222'

function view(overrides: Partial<RunCheckpointView> = {}): RunCheckpointView {
  return {
    runId: RUN_A,
    state: 'sealed',
    changedCount: 2,
    changedFiles: [{ status: 'M', path: 'a.ts' }],
    sealedAt: '2026-09-15T10:00:00Z',
    revert: null,
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
})

describe('useCheckpointStore SSE merge', () => {
  it('merges a run_checkpoint event keyed by runId', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'sealed', changedCount: 3 })
    const record = store.get(RUN_A)
    expect(record?.state).toBe('sealed')
    expect(record?.changedCount).toBe(3)
    expect(record?.sessionId).toBe(SESSION_A)
    expect(record?.loading).toBe(false)
  })

  it('clears changed files when the state changes and keeps them while sealed', () => {
    const store = useCheckpointStore()
    store.mergeEvent({
      runId: RUN_A,
      sessionId: SESSION_A,
      state: 'sealed',
      changedCount: 1,
      revert: { state: 'none', at: null, counts: null, ref: null },
    })
    // A fetch enriches the record with changedFiles.
    store.records[RUN_A].changedFiles = [{ status: 'M', path: 'a.ts' }]
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'sealed', changedCount: 1 })
    expect(store.get(RUN_A)?.changedFiles).toEqual([{ status: 'M', path: 'a.ts' }])
    // A different state invalidates the old file list (and the sticky revert stays).
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'expired', changedCount: 1 })
    expect(store.get(RUN_A)?.changedFiles).toEqual([])
    expect(store.get(RUN_A)?.revert?.state).toBe('none')
  })

  it('merges a revert annotation into the existing record', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'sealed', changedCount: 3 })
    store.mergeEvent({
      runId: RUN_A,
      sessionId: SESSION_A,
      state: 'sealed',
      changedCount: 3,
      revert: { state: 'rolled_back', at: '2026-09-15T11:00:00Z', counts: { restored: 3 }, ref: 'refs/x' },
    })
    expect(store.get(RUN_A)?.revert?.state).toBe('rolled_back')
    expect(store.get(RUN_A)?.revert?.counts).toEqual({ restored: 3 })
  })

  it('ignores an event of another session once the record knows its session', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'sealed', changedCount: 1 })
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_B, state: 'degraded', changedCount: 0, unrollableReason: 'LEASE_HELD' })
    expect(store.get(RUN_A)?.state).toBe('sealed')
  })
})

describe('useCheckpointStore fetch', () => {
  it('fetches the durable projection and stores the session id', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValueOnce(view())
    const store = useCheckpointStore()
    const record = await store.fetchCheckpoint(RUN_A, { sessionId: SESSION_A })
    expect(mockedApi.getRunCheckpoint).toHaveBeenCalledWith(RUN_A)
    expect(record?.state).toBe('sealed')
    expect(record?.sessionId).toBe(SESSION_A)
    expect(store.get(RUN_A)?.changedFiles).toEqual([{ status: 'M', path: 'a.ts' }])
  })

  it('returns the cached record without a second request unless force is set', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValue(view())
    const store = useCheckpointStore()
    await store.fetchCheckpoint(RUN_A)
    await store.fetchCheckpoint(RUN_A)
    expect(mockedApi.getRunCheckpoint).toHaveBeenCalledTimes(1)
    await store.fetchCheckpoint(RUN_A, { force: true })
    expect(mockedApi.getRunCheckpoint).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent requests for the same run', async () => {
    let resolveView: ((value: RunCheckpointView) => void) | null = null
    mockedApi.getRunCheckpoint.mockImplementationOnce(() => new Promise((resolve) => {
      resolveView = resolve
    }))
    const store = useCheckpointStore()
    const first = store.fetchCheckpoint(RUN_A)
    const second = store.fetchCheckpoint(RUN_A)
    // Let the deferred request body reach the API call.
    await flushPromises()
    expect(mockedApi.getRunCheckpoint).toHaveBeenCalledTimes(1)
    resolveView?.(view())
    const [a, b] = await Promise.all([first, second])
    expect(a?.state).toBe('sealed')
    expect(b?.state).toBe('sealed')
  })

  it('drops the record when the run is unknown (404) and keeps it annotated on other errors', async () => {
    const store = useCheckpointStore()
    mockedApi.getRunCheckpoint.mockRejectedValueOnce(new ApiError({
      status: 404,
      code: 'RUN_NOT_FOUND',
      detail: 'Chat run not found',
      requestId: 'req-1',
    }))
    expect(await store.fetchCheckpoint(RUN_A)).toBeNull()
    expect(store.get(RUN_A)).toBeUndefined()

    mockedApi.getRunCheckpoint.mockRejectedValueOnce(new ApiError({
      status: 503,
      code: 'CHECKPOINT_UNAVAILABLE',
      detail: 'git unavailable',
      requestId: 'req-2',
    }))
    const record = await store.fetchCheckpoint(RUN_B, { sessionId: SESSION_A })
    expect(record?.error).toContain('CHECKPOINT_UNAVAILABLE')
    expect(store.get(RUN_B)?.state).toBe('unknown')
  })

  it('ignores a stale response that resolves after a user switch', async () => {
    let resolveView: ((value: RunCheckpointView) => void) | null = null
    mockedApi.getRunCheckpoint.mockImplementationOnce(() => new Promise((resolve) => {
      resolveView = resolve
    }))
    const store = useCheckpointStore()
    const pending = store.fetchCheckpoint(RUN_A, { sessionId: SESSION_A })
    await flushPromises()
    store.clearForUserSwitch()
    resolveView?.(view())
    expect(await pending).toBeNull()
    expect(store.get(RUN_A)).toBeUndefined()
  })
})

describe('useCheckpointStore cleanup', () => {
  it('clearSession removes only the records of that session', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'sealed', changedCount: 1 })
    store.mergeEvent({ runId: RUN_B, sessionId: SESSION_B, state: 'sealed', changedCount: 1 })
    store.clearSession(SESSION_A)
    expect(store.get(RUN_A)).toBeUndefined()
    expect(store.get(RUN_B)?.sessionId).toBe(SESSION_B)
  })

  it('getForSession lists exactly the session records', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'sealed', changedCount: 1 })
    store.mergeEvent({ runId: RUN_B, sessionId: SESSION_A, state: 'degraded', changedCount: 0 })
    expect(store.getForSession(SESSION_A).map((record) => record.runId).sort()).toEqual([RUN_A, RUN_B])
    expect(store.getForSession(SESSION_B)).toEqual([])
  })

  it('getLatestForSession returns the most recently updated record of that session', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'sealed', changedCount: 1 })
    store.records[RUN_A].updatedAt = 100
    store.mergeEvent({ runId: RUN_B, sessionId: SESSION_A, state: 'degraded', changedCount: 0 })
    store.records[RUN_B].updatedAt = 200
    expect(store.getLatestForSession(SESSION_A)?.runId).toBe(RUN_B)
    expect(store.getLatestForSession(SESSION_B)).toBeUndefined()
    expect(store.getLatestForSession('')).toBeUndefined()
  })

  it('getLatestForSession ignores records of other sessions', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'sealed', changedCount: 1 })
    store.records[RUN_A].updatedAt = 500
    store.mergeEvent({ runId: RUN_B, sessionId: SESSION_B, state: 'sealed', changedCount: 1 })
    store.records[RUN_B].updatedAt = 900
    expect(store.getLatestForSession(SESSION_A)?.runId).toBe(RUN_A)
  })

  it('clearForUserSwitch drops every record', async () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_A, sessionId: SESSION_A, state: 'sealed', changedCount: 1 })
    store.clearForUserSwitch()
    await flushPromises()
    expect(store.get(RUN_A)).toBeUndefined()
    expect(store.records).toEqual({})
  })
})
