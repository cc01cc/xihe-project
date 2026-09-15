import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { setActivePinia, createPinia } from 'pinia'
import RunCheckpointMarker from '../RunCheckpointMarker.vue'
import { api } from '../../../composables/api'
import { useCheckpointStore } from '../../../stores/checkpoint'
import type { RunCheckpointView } from '../../../types'

vi.mock('../../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getRunCheckpoint: vi.fn(),
    },
  }
})

const mockedApi = vi.mocked(api, true)

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const SESSION_ID = '44444444-4444-4444-8444-444444444444'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      chat: {
        checkpointMarkerChangedPrefix: 'This run changed',
        checkpointMarkerChangedUnit: 'file(s)',
        checkpointMarkerRollbackable: 'rollback available',
        checkpointMarkerRevertEntry: 'Restore…',
        checkpointMarkerNoSnapshot: 'No snapshot for this run',
        checkpointMarkerUnsealed: 'snapshot not sealed',
        checkpointMarkerUnrollable: 'This run cannot be rolled back',
        checkpointMarkerReverted: 'Restored to the previous state',
        checkpointCountRestored: 'restored',
        checkpointCountDeleted: 'deleted',
        checkpointCountSkipped: 'skipped',
        checkpointCountFailed: 'failed',
        checkpointReasonLeaseHeld: 'another run holds the workspace lease',
        checkpointReasonUnavailable: 'snapshot capability unavailable',
        checkpointReasonGitUnavailable: 'no usable git detected',
        checkpointReasonGitTooOld: 'git version too old',
        checkpointReasonGitFailed: 'git operation failed',
        checkpointReasonWorkspaceUnknown: 'workspace unavailable',
        checkpointReasonExpired: 'snapshot expired',
        checkpointReasonMissing: 'snapshot missing',
        checkpointReasonUnknownState: 'snapshot state unknown',
      },
    },
  },
})

function mountMarker(props: { runId?: string; sessionId?: string } = {}) {
  return mount(RunCheckpointMarker, {
    props: { runId: props.runId ?? RUN_ID, sessionId: props.sessionId ?? SESSION_ID },
    global: { plugins: [i18n] },
  })
}

function view(overrides: Partial<RunCheckpointView> = {}): RunCheckpointView {
  return {
    runId: RUN_ID,
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

describe('RunCheckpointMarker', () => {
  it('renders the rollbackable marker with count, revert entry and file title', () => {
    const store = useCheckpointStore()
    store.mergeEvent({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      state: 'sealed',
      changedCount: 3,
      revert: { state: 'none', at: null, counts: null, ref: null },
    })
    store.records[RUN_ID].changedFiles = [{ status: 'M', path: 'a.ts' }]
    const wrapper = mountMarker()
    expect(wrapper.find('[data-testid="run-checkpoint-marker"]').attributes('data-checkpoint-kind')).toBe('rollbackable')
    expect(wrapper.find('[data-testid="run-checkpoint-summary"]').text()).toContain('This run changed 3 file(s)')
    expect(wrapper.find('[data-testid="run-checkpoint-summary"]').text()).toContain('rollback available')
    expect(wrapper.find('[data-testid="run-checkpoint-summary"]').attributes('title')).toBe('M a.ts')
    expect(wrapper.find('[data-testid="run-checkpoint-revert-entry"]').exists()).toBe(true)
  })

  it('emits revert with the run id when the entry is clicked', async () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_ID, sessionId: SESSION_ID, state: 'sealed', changedCount: 1 })
    const wrapper = mountMarker()
    await wrapper.find('[data-testid="run-checkpoint-revert-entry"]').trigger('click')
    expect(wrapper.emitted('revert')).toEqual([[RUN_ID]])
  })

  it('renders the no-snapshot marker without an entry for state none', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_ID, sessionId: SESSION_ID, state: 'none', changedCount: 0 })
    const wrapper = mountMarker()
    expect(wrapper.find('[data-testid="run-checkpoint-marker"]').attributes('data-checkpoint-kind')).toBe('none')
    expect(wrapper.find('[data-testid="run-checkpoint-none"]').text()).toContain('No snapshot for this run')
    expect(wrapper.find('[data-testid="run-checkpoint-revert-entry"]').exists()).toBe(false)
  })

  it('marks base and unsealed states as not yet sealed', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_ID, sessionId: SESSION_ID, state: 'base', changedCount: 0 })
    const wrapper = mountMarker()
    expect(wrapper.find('[data-testid="run-checkpoint-none"]').text()).toContain('snapshot not sealed')
  })

  it('renders the unrollable marker with the frozen degraded reason', () => {
    const store = useCheckpointStore()
    store.mergeEvent({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      state: 'degraded',
      changedCount: 0,
      unrollableReason: 'GIT_UNAVAILABLE',
    })
    const wrapper = mountMarker()
    expect(wrapper.find('[data-testid="run-checkpoint-marker"]').attributes('data-checkpoint-kind')).toBe('unavailable')
    expect(wrapper.find('[data-testid="run-checkpoint-unavailable"]').text()).toContain('cannot be rolled back')
    expect(wrapper.find('[data-testid="run-checkpoint-unavailable"]').text()).toContain('no usable git detected')
    expect(wrapper.find('[data-testid="run-checkpoint-revert-entry"]').exists()).toBe(false)
  })

  it('labels the expired state without inventing a reason', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_ID, sessionId: SESSION_ID, state: 'expired', changedCount: 0 })
    const wrapper = mountMarker()
    expect(wrapper.find('[data-testid="run-checkpoint-unavailable"]').text()).toContain('snapshot expired')
  })

  it('treats an out-of-contract state as unavailable instead of rollbackable', () => {
    const store = useCheckpointStore()
    store.mergeEvent({ runId: RUN_ID, sessionId: SESSION_ID, state: 'unknown', changedCount: 0 })
    const wrapper = mountMarker()
    expect(wrapper.find('[data-testid="run-checkpoint-marker"]').attributes('data-checkpoint-kind')).toBe('unavailable')
    expect(wrapper.find('[data-testid="run-checkpoint-revert-entry"]').exists()).toBe(false)
  })

  it('renders the reverted marker with time and summary counts', () => {
    const store = useCheckpointStore()
    store.mergeEvent({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      state: 'sealed',
      changedCount: 2,
      revert: {
        state: 'partial',
        at: '2026-09-15T11:00:00Z',
        counts: { restored: 1, skippedConflict: 1, failed: 0 },
        ref: 'refs/x',
      },
    })
    const wrapper = mountMarker()
    expect(wrapper.find('[data-testid="run-checkpoint-marker"]').attributes('data-checkpoint-kind')).toBe('reverted')
    const reverted = wrapper.find('[data-testid="run-checkpoint-reverted"]')
    expect(reverted.text()).toContain('Restored to the previous state')
    expect(reverted.text()).toContain('restored 1')
    expect(reverted.text()).toContain('skipped 1')
    expect(wrapper.find('[data-testid="run-checkpoint-revert-entry"]').exists()).toBe(false)
  })

  it('fetches the projection on mount when no record exists', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValueOnce(view())
    const wrapper = mountMarker()
    await flushPromises()
    expect(mockedApi.getRunCheckpoint).toHaveBeenCalledWith(RUN_ID)
    expect(wrapper.find('[data-testid="run-checkpoint-marker"]').attributes('data-checkpoint-kind')).toBe('rollbackable')
    expect(useCheckpointStore().get(RUN_ID)?.sessionId).toBe(SESSION_ID)
  })

  it('renders nothing while the projection is unavailable', async () => {
    mockedApi.getRunCheckpoint.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mountMarker()
    await flushPromises()
    expect(wrapper.find('[data-testid="run-checkpoint-marker"]').exists()).toBe(false)
  })
})
