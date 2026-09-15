import { defineStore } from 'pinia'
import { ref } from 'vue'
import { ApiError, api } from '../composables/api'
import { logger } from '../lib/logger'
import type {
  RunCheckpointChangedFile,
  RunCheckpointEvent,
  RunCheckpointRevertView,
  RunCheckpointState,
} from '../types'

/**
 * Per-Run checkpoint state consumed by the chat timeline (PLAN-0328 M3 W3).
 *
 * Two write paths merge into one map keyed by `runId`:
 * - the SSE `run_checkpoint` lifecycle annotation (authoritative for state/revert); and
 * - the durable GET projection fetched on demand when a message needs a marker.
 * Records remember their `sessionId` so a session switch/logout can drop exactly
 * the sessions it owns; they are never persisted to localStorage.
 */
export interface RunCheckpointRecord {
  runId: string
  sessionId: string | null
  state: RunCheckpointState
  unrollableReason: string | null
  changedCount: number
  changedFiles: RunCheckpointChangedFile[]
  sealedAt: string | null
  revert: RunCheckpointRevertView | null
  loading: boolean
  error: string | null
  /** True once an authoritative projection (SSE or GET) was merged; error-only records stay false. */
  loaded: boolean
  updatedAt: number
}

function errorMessage(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) {
    return `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
  }
  return cause instanceof Error ? cause.message : fallback
}

export const useCheckpointStore = defineStore('checkpoint', () => {
  const records = ref<Record<string, RunCheckpointRecord>>({})
  const inFlight = new Map<string, Promise<RunCheckpointRecord | null>>()
  let storeGeneration = 0

  function get(runId: string): RunCheckpointRecord | undefined {
    return records.value[runId]
  }

  function getForSession(sessionId: string): RunCheckpointRecord[] {
    return Object.values(records.value).filter((record) => record.sessionId === sessionId)
  }

  /**
   * Most recently updated record of a session — the run the workspace change view should fall
   * back to when no live run id is known. Returns `undefined` when the session has no record.
   */
  function getLatestForSession(sessionId: string): RunCheckpointRecord | undefined {
    if (!sessionId) return undefined
    let latest: RunCheckpointRecord | undefined
    for (const record of Object.values(records.value)) {
      if (record.sessionId !== sessionId) continue
      if (!latest || record.updatedAt >= latest.updatedAt) latest = record
    }
    return latest
  }

  function ensureRecord(runId: string, sessionId?: string): RunCheckpointRecord {
    const existing = records.value[runId]
    if (existing) {
      if (sessionId && !existing.sessionId) existing.sessionId = sessionId
      return existing
    }
    const created: RunCheckpointRecord = {
      runId,
      sessionId: sessionId ?? null,
      state: 'unknown',
      unrollableReason: null,
      changedCount: 0,
      changedFiles: [],
      sealedAt: null,
      revert: null,
      loading: false,
      error: null,
      loaded: false,
      updatedAt: Date.now(),
    }
    records.value[runId] = created
    return created
  }

  /**
   * Merge one SSE event. Events only annotate lifecycle: `changedFiles` are kept only while the
   * state stays sealed (a new state invalidates the old file list), and an absent `revert` keeps
   * the previous one because the last revert attempt is sticky.
   */
  function mergeEvent(event: RunCheckpointEvent): void {
    const previous = records.value[event.runId]
    if (previous?.sessionId && event.sessionId && previous.sessionId !== event.sessionId) return
    records.value[event.runId] = {
      runId: event.runId,
      sessionId: event.sessionId || previous?.sessionId || null,
      state: event.state,
      unrollableReason: event.unrollableReason ?? null,
      changedCount: event.changedCount,
      changedFiles: event.state === 'sealed' && previous?.state === 'sealed' ? previous.changedFiles : [],
      sealedAt: event.state === 'sealed' ? previous?.sealedAt ?? null : null,
      revert: event.revert !== undefined ? event.revert : previous?.revert ?? null,
      loading: false,
      error: null,
      loaded: true,
      updatedAt: Date.now(),
    }
  }

  /**
   * Fetch the durable projection on demand. Dedupes concurrent requests per run and keeps the
   * last successful projection unless `force` is set. 404 (unknown/foreign run) drops the record:
   * there is no marker evidence, and a stale one must not survive.
   */
  async function fetchCheckpoint(runId: string, options: { sessionId?: string; force?: boolean } = {}): Promise<RunCheckpointRecord | null> {
    if (!runId) return null
    const existing = records.value[runId]
    if (!options.force && existing && !existing.error && !existing.loading) return existing
    const pending = inFlight.get(runId)
    if (pending) return pending

    const requestGeneration = storeGeneration
    const request = Promise.resolve().then(async (): Promise<RunCheckpointRecord | null> => {
      const record = ensureRecord(runId, options.sessionId)
      record.loading = true
      record.error = null
      try {
        const view = await api.getRunCheckpoint(runId)
        if (requestGeneration !== storeGeneration) return null
        const current = records.value[runId]
        const merged: RunCheckpointRecord = {
          runId,
          sessionId: options.sessionId ?? current?.sessionId ?? null,
          state: view.state,
          unrollableReason: view.unrollableReason ?? null,
          changedCount: view.changedCount,
          changedFiles: view.changedFiles,
          sealedAt: view.sealedAt,
          revert: view.revert,
          loading: false,
          error: null,
          loaded: true,
          updatedAt: Date.now(),
        }
        records.value[runId] = merged
        return merged
      } catch (cause) {
        if (requestGeneration !== storeGeneration) return null
        if (cause instanceof ApiError && cause.problem.status === 404) {
          delete records.value[runId]
          return null
        }
        const current = records.value[runId]
        if (current) {
          current.loading = false
          current.error = errorMessage(cause, 'Failed to load run checkpoint')
        }
        logger.warn('Failed to load run checkpoint', cause)
        return current ?? null
      } finally {
        if (inFlight.get(runId) === request) inFlight.delete(runId)
      }
    })
    inFlight.set(runId, request)
    return request
  }

  function clearSession(sessionId: string): void {
    if (!sessionId) return
    for (const [runId, record] of Object.entries(records.value)) {
      if (record.sessionId === sessionId) delete records.value[runId]
    }
  }

  /** Drops every record and invalidates in-flight responses (logout / user switch). */
  function clearForUserSwitch(): void {
    storeGeneration += 1
    records.value = {}
    inFlight.clear()
  }

  return {
    records,
    get,
    getForSession,
    getLatestForSession,
    mergeEvent,
    fetchCheckpoint,
    clearSession,
    clearForUserSwitch,
  }
})
