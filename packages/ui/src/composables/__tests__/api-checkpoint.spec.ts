import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  api,
  ApiError,
  normalizeCheckpointGcResult,
  normalizeCheckpointRetention,
  normalizeRevertPreview,
  normalizeRevertResult,
  normalizeRunCheckpoint,
  normalizeRunCheckpointEvent,
  normalizeWorkspaceGitStatus,
} from '../api'

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const WORKSPACE_ID = '66666666-6666-4666-8666-666666666666'
const SESSION_ID = '55555555-5555-4555-8555-555555555555'

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  localStorage.clear()
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  fetchSpy.mockRestore()
})

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
    headers: new Headers(),
  } as unknown as Response
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    headers: new Headers(),
  } as unknown as Response
}

describe('normalizeRunCheckpoint', () => {
  it('normalizes a sealed projection with changed files and a revert view', () => {
    const view = normalizeRunCheckpoint({
      runId: RUN_ID,
      checkpointId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      state: 'sealed',
      unrollableReason: null,
      changedCount: 25,
      changedFiles: [{ status: 'M', path: 'src/app.ts' }, { status: 'A', path: 'src/new.ts' }],
      sealedAt: '2026-09-15T10:00:00Z',
      revert: {
        state: 'partial',
        at: '2026-09-15T11:00:00Z',
        counts: { restored: 2, deleted: 1, skippedConflict: 1, failed: 0, noop: 3 },
        ref: 'refs/xihe/run/rollback/1',
      },
    })
    expect(view).not.toBeNull()
    expect(view?.state).toBe('sealed')
    expect(view?.changedCount).toBe(25)
    expect(view?.changedFiles).toEqual([
      { status: 'M', path: 'src/app.ts' },
      { status: 'A', path: 'src/new.ts' },
    ])
    expect(view?.sealedAt).toBe('2026-09-15T10:00:00Z')
    expect(view?.revert?.state).toBe('partial')
    expect(view?.revert?.counts).toEqual({ restored: 2, deleted: 1, skippedConflict: 1, failed: 0, noop: 3 })
    expect(view?.revert?.ref).toBe('refs/xihe/run/rollback/1')
    expect(view?.checkpointId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  it('accepts the revertRef alias for the audit ref', () => {
    const view = normalizeRunCheckpoint({
      runId: RUN_ID,
      state: 'sealed',
      revert: { state: 'rolled_back', revertRef: 'refs/xihe/run/rollback/2' },
    })
    expect(view?.revert?.ref).toBe('refs/xihe/run/rollback/2')
  })

  it('keeps state=none with a revert view of none', () => {
    const view = normalizeRunCheckpoint({
      runId: RUN_ID,
      state: 'none',
      changedCount: 0,
      changedFiles: [],
      sealedAt: null,
      revert: { state: 'none', at: null, counts: null, ref: null },
    })
    expect(view?.state).toBe('none')
    expect(view?.revert?.state).toBe('none')
    expect(view?.revert?.counts).toBeNull()
  })

  it('falls back to unknown for an out-of-contract state instead of fabricating sealed', () => {
    const view = normalizeRunCheckpoint({ runId: RUN_ID, state: 'sealed-ish' })
    expect(view?.state).toBe('unknown')
  })

  it('falls back to unknown for an out-of-contract revert state', () => {
    const view = normalizeRunCheckpoint({ runId: RUN_ID, state: 'sealed', revert: { state: 'bogus' } })
    expect(view?.revert?.state).toBe('unknown')
  })

  it('tolerates absent nullable fields', () => {
    const view = normalizeRunCheckpoint({ runId: RUN_ID, state: 'degraded', unrollableReason: 'GIT_UNAVAILABLE' })
    expect(view?.changedCount).toBe(0)
    expect(view?.changedFiles).toEqual([])
    expect(view?.sealedAt).toBeNull()
    expect(view?.revert).toBeNull()
    expect(view?.unrollableReason).toBe('GIT_UNAVAILABLE')
  })

  it('skips malformed changed-file entries and drops non-numeric revert counts', () => {
    const view = normalizeRunCheckpoint({
      runId: RUN_ID,
      state: 'sealed',
      changedCount: 'many',
      changedFiles: [{ status: 'M', path: 'ok.ts' }, { path: '' }, 'nope', null],
      revert: { state: 'partial', counts: { restored: 1, failed: 'x', noop: -2 } },
    })
    expect(view?.changedCount).toBe(0)
    expect(view?.changedFiles).toEqual([{ status: 'M', path: 'ok.ts' }])
    expect(view?.revert?.counts).toEqual({ restored: 1 })
  })

  it('uses the fallback runId and rejects unusable payloads', () => {
    expect(normalizeRunCheckpoint({ state: 'sealed' }, RUN_ID)?.runId).toBe(RUN_ID)
    expect(normalizeRunCheckpoint({ state: 'sealed' })).toBeNull()
    expect(normalizeRunCheckpoint(null)).toBeNull()
    expect(normalizeRunCheckpoint('sealed')).toBeNull()
  })
})

describe('normalizeRunCheckpointEvent', () => {
  it('normalizes a sealed event and keeps the fallback session id', () => {
    const event = normalizeRunCheckpointEvent(
      { runId: RUN_ID, state: 'sealed', changedCount: 4 },
      SESSION_ID,
    )
    expect(event).toEqual({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      state: 'sealed',
      changedCount: 4,
    })
  })

  it('parses the revert annotation of a completed revert event', () => {
    const event = normalizeRunCheckpointEvent({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      state: 'sealed',
      changedCount: 4,
      revert: { state: 'rolled_back', at: '2026-09-15T11:00:00Z', counts: { restored: 4 }, ref: null },
    }, SESSION_ID)
    expect(event?.revert?.state).toBe('rolled_back')
    expect(event?.revert?.counts).toEqual({ restored: 4 })
  })

  it('drops events of another session and unusable payloads', () => {
    expect(normalizeRunCheckpointEvent({ runId: RUN_ID, sessionId: 'other', state: 'sealed' }, SESSION_ID)).toBeNull()
    expect(normalizeRunCheckpointEvent({ sessionId: SESSION_ID, state: 'sealed' }, SESSION_ID)).toBeNull()
    expect(normalizeRunCheckpointEvent(null, SESSION_ID)).toBeNull()
  })

  it('falls back to unknown for an out-of-contract state and 0 for an invalid count', () => {
    const event = normalizeRunCheckpointEvent(
      { runId: RUN_ID, state: 'nonsense', changedCount: 'x' },
      SESSION_ID,
    )
    expect(event?.state).toBe('unknown')
    expect(event?.changedCount).toBe(0)
    expect(event?.unrollableReason).toBeUndefined()
  })
})

describe('normalizeRevertPreview', () => {
  const validPreview = {
    runId: RUN_ID,
    state: 'sealed',
    counts: { restore: 3, delete: 1, skipConflicts: 1, noop: 2 },
    entries: [
      { path: 'src/a.ts', action: 'restore' },
      { path: 'src/b.ts', oldPath: 'src/old-b.ts', action: 'delete', conflictReason: 'CONTENT_CHANGED' },
      { path: 'src/c.ts', action: 'teleport' },
      { path: '', action: 'restore' },
    ],
    headFingerprint: { recorded: 'abc', current: 'def', status: 'changed' },
    sealedWithLiveJobs: true,
    truncated: true,
  }

  it('normalizes counts, entries, head fingerprint and caveats', () => {
    const preview = normalizeRevertPreview(validPreview)
    expect(preview?.counts).toEqual({ restore: 3, delete: 1, skipConflicts: 1, noop: 2 })
    expect(preview?.entries).toEqual([
      { path: 'src/a.ts', action: 'restore' },
      { path: 'src/b.ts', oldPath: 'src/old-b.ts', action: 'delete', conflictReason: 'CONTENT_CHANGED' },
      { path: 'src/c.ts', action: 'unknown' },
    ])
    expect(preview?.headFingerprint).toEqual({ recorded: 'abc', current: 'def', status: 'changed' })
    expect(preview?.sealedWithLiveJobs).toBe(true)
    expect(preview?.truncated).toBe(true)
  })

  it('returns null counts when the preview projection is incomplete', () => {
    expect(normalizeRevertPreview({ ...validPreview, counts: { restore: 1, delete: 1, skipConflicts: 'x', noop: 0 } })?.counts).toBeNull()
    expect(normalizeRevertPreview({ ...validPreview, counts: null })?.counts).toBeNull()
  })

  it('falls back to unknown for a missing or out-of-contract head fingerprint', () => {
    expect(normalizeRevertPreview({ ...validPreview, headFingerprint: { status: 'weird' } })?.headFingerprint)
      .toEqual({ recorded: null, current: null, status: 'unknown' })
    expect(normalizeRevertPreview({ ...validPreview, headFingerprint: undefined })?.headFingerprint)
      .toEqual({ recorded: null, current: null, status: 'unknown' })
    expect(normalizeRevertPreview({ ...validPreview, headFingerprint: { status: 'not_repo' } })?.headFingerprint.status)
      .toBe('not_repo')
  })

  it('does not fabricate booleans and rejects unusable payloads', () => {
    const preview = normalizeRevertPreview({ ...validPreview, sealedWithLiveJobs: 'yes', truncated: 0 })
    expect(preview?.sealedWithLiveJobs).toBe(false)
    expect(preview?.truncated).toBe(false)
    expect(normalizeRevertPreview(null)).toBeNull()
    expect(normalizeRevertPreview('nope')).toBeNull()
  })
})

describe('normalizeRevertResult', () => {
  const validResult = {
    runId: RUN_ID,
    revertRef: 'refs/xihe/run/rollback/3',
    counts: { restored: 2, deleted: 1, skippedConflict: 1, failed: 0, noop: 4 },
    entries: [
      { path: 'src/a.ts', result: 'restored' },
      { path: 'src/b.ts', result: 'skippedConflict', reason: 'CONTENT_CHANGED' },
      { path: 'src/c.ts', result: 'mystery', reason: 'x' },
      { path: '', result: 'failed' },
    ],
    durationMs: 42,
  }

  it('normalizes counts, entries and duration', () => {
    const result = normalizeRevertResult(validResult)
    expect(result?.counts).toEqual({ restored: 2, deleted: 1, skippedConflict: 1, failed: 0, noop: 4 })
    expect(result?.entries).toEqual([
      { path: 'src/a.ts', result: 'restored' },
      { path: 'src/b.ts', result: 'skippedConflict', reason: 'CONTENT_CHANGED' },
      { path: 'src/c.ts', result: 'unknown', reason: 'x' },
    ])
    expect(result?.durationMs).toBe(42)
    expect(result?.revertRef).toBe('refs/xihe/run/rollback/3')
  })

  it('keeps an absent audit ref null and defaults invalid counts/duration without inventing outcomes', () => {
    const result = normalizeRevertResult({
      runId: RUN_ID,
      counts: { restored: 1 },
      durationMs: -5,
      entries: [],
    })
    expect(result?.revertRef).toBeNull()
    expect(result?.counts).toBeNull()
    expect(result?.durationMs).toBe(0)
  })

  it('rejects unusable payloads', () => {
    expect(normalizeRevertResult({ counts: validResult.counts })).toBeNull()
    expect(normalizeRevertResult(null)).toBeNull()
  })
})

describe('normalizeWorkspaceGitStatus', () => {
  it('normalizes entries and requires a strict isRepository boolean', () => {
    expect(normalizeWorkspaceGitStatus({
      isRepository: true,
      entries: [{ status: 'M', path: 'a.ts' }, { path: '' }],
    })).toEqual({ isRepository: true, entries: [{ status: 'M', path: 'a.ts' }] })
    expect(normalizeWorkspaceGitStatus({ isRepository: 'yes', entries: [] })).toEqual({ isRepository: false, entries: [] })
    expect(normalizeWorkspaceGitStatus(null)).toEqual({ isRepository: false, entries: [] })
  })
})

describe('normalizeCheckpointRetention', () => {
  it('normalizes the constants and counts', () => {
    expect(normalizeCheckpointRetention({
      maxRuns: 50,
      ttlDays: 30,
      unsealedNeverDeleted: true,
      currentRuns: 7,
      currentRefs: 13,
    })).toEqual({ maxRuns: 50, ttlDays: 30, unsealedNeverDeleted: true, currentRuns: 7, currentRefs: 13 })
  })

  it('throws on malformed payloads', () => {
    expect(() => normalizeCheckpointRetention({ maxRuns: 50 })).toThrow('Invalid checkpoint retention response')
    expect(() => normalizeCheckpointRetention(null)).toThrow('Invalid checkpoint retention response')
  })
})

describe('normalizeCheckpointGcResult', () => {
  it('keeps only numeric counts', () => {
    expect(normalizeCheckpointGcResult({ counts: { deleted: 3, refs: 6, note: 'x' } })).toEqual({ deleted: 3, refs: 6 })
    expect(normalizeCheckpointGcResult({})).toEqual({})
    expect(normalizeCheckpointGcResult(null)).toEqual({})
  })
})

describe('checkpoint api functions', () => {
  it('getRunCheckpoint GETs the projection and normalizes it', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ runId: RUN_ID, state: 'sealed', changedCount: 1 }))
    const view = await api.getRunCheckpoint(RUN_ID)
    expect(view.state).toBe('sealed')
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/v1/chat/runs/${RUN_ID}/checkpoint`,
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })

  it('previewRunCheckpointRevert POSTs the dry-run route', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      runId: RUN_ID,
      state: 'sealed',
      counts: { restore: 0, delete: 0, skipConflicts: 0, noop: 0 },
      entries: [],
      headFingerprint: { status: 'ok' },
      sealedWithLiveJobs: false,
      truncated: false,
    }))
    const preview = await api.previewRunCheckpointRevert(RUN_ID)
    expect(preview.headFingerprint.status).toBe('ok')
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/v1/chat/runs/${RUN_ID}/checkpoint/revert/preview`,
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('executeRunCheckpointRevert sends acknowledgements and normalizes the result', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      runId: RUN_ID,
      revertRef: 'refs/xihe/x/rollback/1',
      counts: { restored: 1, deleted: 0, skippedConflict: 1, failed: 0, noop: 0 },
      entries: [{ path: 'a.ts', result: 'restored' }],
      durationMs: 10,
    }))
    const result = await api.executeRunCheckpointRevert(RUN_ID, {
      acknowledgeConflicts: ['b.ts'],
      acknowledgeHeadChange: true,
    })
    expect(result.counts?.restored).toBe(1)
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(init.body).toBe(JSON.stringify({ acknowledgeHeadChange: true, acknowledgeConflicts: ['b.ts'] }))
  })

  it('executeRunCheckpointRevert omits an empty acknowledgeConflicts list', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      runId: RUN_ID,
      counts: { restored: 0, deleted: 0, skippedConflict: 0, failed: 0, noop: 1 },
      entries: [],
      durationMs: 1,
    }))
    await api.executeRunCheckpointRevert(RUN_ID, { acknowledgeConflicts: [], acknowledgeHeadChange: false })
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(init.body).toBe(JSON.stringify({ acknowledgeHeadChange: false }))
  })

  it('surfaces 409 checkpoint conflicts as ApiError', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      status: 409,
      code: 'CHECKPOINT_CONFLICTS_UNACKNOWLEDGED',
      detail: 'conflict paths must be acknowledged from the preview before reverting',
      requestId: 'req-1',
    }, 409))
    const promise = api.executeRunCheckpointRevert(RUN_ID, { acknowledgeConflicts: [], acknowledgeHeadChange: false })
    await expect(promise).rejects.toBeInstanceOf(ApiError)
    await expect(promise).rejects.toMatchObject({ problem: { code: 'CHECKPOINT_CONFLICTS_UNACKNOWLEDGED', status: 409 } })
  })

  it('getRunCheckpointFile reads the plain-text blob with path and ref', async () => {
    fetchSpy.mockResolvedValueOnce(textResponse('line one\nline two'))
    const content = await api.getRunCheckpointFile(RUN_ID, 'src/a b.ts', 'end')
    expect(content).toBe('line one\nline two')
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/v1/chat/runs/${RUN_ID}/checkpoint/file?path=src%2Fa+b.ts&ref=end`,
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })

  it('getWorkspaceCheckpointRetention and gc pass the workspace header', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({
      maxRuns: 50,
      ttlDays: 30,
      unsealedNeverDeleted: true,
      currentRuns: 1,
      currentRefs: 2,
    }))
    const retention = await api.getWorkspaceCheckpointRetention(WORKSPACE_ID)
    expect(retention.maxRuns).toBe(50)
    const retentionInit = fetchSpy.mock.calls[0][1] as RequestInit
    expect((retentionInit.headers as Record<string, string>)['X-Workspace-Id']).toBe(WORKSPACE_ID)

    fetchSpy.mockResolvedValueOnce(jsonResponse({ counts: { deleted: 2 } }))
    const counts = await api.runWorkspaceCheckpointGc(WORKSPACE_ID)
    expect(counts).toEqual({ deleted: 2 })
    expect(fetchSpy).toHaveBeenLastCalledWith(
      `/api/v1/workspaces/${WORKSPACE_ID}/checkpoints/gc`,
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('getWorkspaceGitStatus normalizes isRepository and entries', async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ isRepository: true, entries: [{ status: 'M', path: 'a.ts' }] }))
    const status = await api.getWorkspaceGitStatus(WORKSPACE_ID)
    expect(status).toEqual({ isRepository: true, entries: [{ status: 'M', path: 'a.ts' }] })
  })
})
