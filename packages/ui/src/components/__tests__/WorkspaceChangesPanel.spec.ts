import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import WorkspaceChangesPanel from '../workspace/WorkspaceChangesPanel.vue'
import { ApiError, api } from '../../composables/api'
import { useCheckpointStore } from '../../stores/checkpoint'
import { useChatStore } from '../../stores/chat'
import type { RunCheckpointView, WorkspaceGitStatus } from '../../types'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getRunCheckpoint: vi.fn(),
      getWorkspaceGitStatus: vi.fn(),
    },
  }
})

const mockedApi = vi.mocked(api, true)

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const SESSION_ID = '44444444-4444-4444-8444-444444444444'
const WORKSPACE_ID = '66666666-6666-4666-8666-666666666666'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      workspace: {
        panelCode: 'Code',
        panelChanges: 'Changes',
        diffTabRun: 'This run',
        diffTabPending: 'Pending commit',
        diffDifferenceNote: 'The two lists may differ; this-run changes being a subset of pending changes is normal, and they are never merged.',
        diffRunLoading: 'Loading this run\u2019s changes…',
        diffRunFailed: 'Failed to load this run\u2019s changes',
        diffRunEmpty: 'This session has no run snapshot yet.',
        diffRunClean: 'No files changed in this run.',
        diffRunChangedUnit: 'file(s)',
        diffRunListIncomplete: 'The server did not return the file list, only the count.',
        diffRunStateUnrollable: 'This run cannot be rolled back',
        diffRunStateUnsealed: 'snapshot not sealed',
        diffRunStateExpired: 'snapshot expired',
        diffRunStateNone: 'no snapshot for this run',
        diffRunStateUnknown: 'snapshot state unknown',
        diffPendingLoading: 'Reading git status…',
        diffPendingLoadFailed: 'Failed to load the pending-commit status',
        diffPendingRetry: 'Retry',
        diffPendingNoRepo: 'No pending-commit view',
        diffPendingEmpty: 'Nothing pending commit.',
        diffPendingCountUnit: 'file(s)',
        diffRefresh: 'Refresh pending-commit status',
        closePanel: 'Close',
      },
    },
  },
})

function checkpointView(overrides: Partial<RunCheckpointView> = {}): RunCheckpointView {
  return {
    runId: RUN_ID,
    state: 'sealed',
    changedCount: 2,
    changedFiles: [
      { status: 'M', path: 'src/parser.ts' },
      { status: 'A', path: 'src/index.ts' },
    ],
    sealedAt: '2026-09-15T10:00:00Z',
    revert: null,
    ...overrides,
  }
}

function gitStatus(overrides: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    isRepository: true,
    entries: [{ status: 'M', path: 'README.md' }],
    ...overrides,
  }
}

function mountPanel() {
  return mount(WorkspaceChangesPanel, {
    props: { sessionId: SESSION_ID, workspaceId: WORKSPACE_ID },
    global: { plugins: [i18n] },
  })
}

async function settle() {
  await flushPromises()
  await flushPromises()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  // Any known projection record (SSE annotation or a previous fetch) resolves the session's
  // latest run id; the panel then re-reads the authoritative projection.
  useCheckpointStore().mergeEvent({
    runId: RUN_ID,
    sessionId: SESSION_ID,
    state: 'sealed',
    changedCount: 2,
  })
})

describe('WorkspaceChangesPanel dual diff (PLAN-0328 M3 T3.8)', () => {
  it('renders two labeled tabs and the explicit difference note without merging the lists', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValue(checkpointView())
    mockedApi.getWorkspaceGitStatus.mockResolvedValue(gitStatus())
    const wrapper = mountPanel()
    await settle()

    const runTab = wrapper.find('[data-testid="workspace-diff-tab-run"]')
    const pendingTab = wrapper.find('[data-testid="workspace-diff-tab-pending"]')
    expect(runTab.text()).toBe('This run')
    expect(pendingTab.text()).toBe('Pending commit')
    expect(runTab.attributes('aria-selected')).toBe('true')
    expect(pendingTab.attributes('aria-selected')).toBe('false')
    expect(wrapper.find('[data-testid="workspace-diff-difference-note"]').text())
      .toContain('never merged')

    // The run tab lists only checkpoint files; the pending-only path is not rendered at all.
    expect(wrapper.find('[data-testid="workspace-diff-run-list"]').text()).toContain('src/parser.ts')
    expect(wrapper.find('[data-testid="workspace-diff-run-list"]').text()).toContain('src/index.ts')
    expect(wrapper.find('[data-testid="workspace-diff-pending-list"]').exists()).toBe(false)
  })

  it('sources the run tab from the checkpoint projection of the latest known run of the session', async () => {
    useCheckpointStore().mergeEvent({
      runId: RUN_ID,
      sessionId: SESSION_ID,
      state: 'sealed',
      changedCount: 7,
    })
    mockedApi.getRunCheckpoint.mockResolvedValue(checkpointView({ changedCount: 7 }))
    mockedApi.getWorkspaceGitStatus.mockResolvedValue(gitStatus())
    // The fallback path: the session has no live run id, only a projection record.
    const wrapper = mountPanel()
    await settle()

    expect(mockedApi.getRunCheckpoint).toHaveBeenCalledWith(RUN_ID)
    expect(wrapper.find('[data-testid="workspace-diff-run-count"]').text()).toContain('7')
    expect(wrapper.findAll('[data-testid="workspace-diff-run-entry"]')).toHaveLength(2)
  })

  it('shows pending entries on the second tab without ever mixing them into the run list', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValue(checkpointView())
    mockedApi.getWorkspaceGitStatus.mockResolvedValue(gitStatus({
      entries: [
        { status: 'M', path: 'README.md' },
        { status: '??', path: 'notes/draft.md' },
      ],
    }))
    const wrapper = mountPanel()
    await settle()
    await wrapper.find('[data-testid="workspace-diff-tab-pending"]').trigger('click')

    const pendingList = wrapper.find('[data-testid="workspace-diff-pending-list"]')
    expect(pendingList.text()).toContain('README.md')
    expect(pendingList.text()).toContain('notes/draft.md')
    expect(pendingList.text()).not.toContain('src/index.ts')
    expect(wrapper.find('[data-testid="workspace-diff-run-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-diff-pending-count"]').text()).toContain('2')
  })

  it('renders an explicit no-pending-view state when the workspace is not a git repository', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValue(checkpointView())
    mockedApi.getWorkspaceGitStatus.mockResolvedValue({ isRepository: false, entries: [] })
    const wrapper = mountPanel()
    await settle()
    await wrapper.find('[data-testid="workspace-diff-tab-pending"]').trigger('click')

    expect(wrapper.find('[data-testid="workspace-diff-pending-no-repo"]').text()).toContain('No pending-commit view')
    expect(wrapper.find('[data-testid="workspace-diff-pending-list"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-diff-pending-empty"]').exists()).toBe(false)
  })

  it('refreshes the git-status side through the small refresh action', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValue(checkpointView())
    mockedApi.getWorkspaceGitStatus
      .mockResolvedValueOnce({ isRepository: false, entries: [] })
      .mockResolvedValueOnce(gitStatus({ entries: [{ status: 'M', path: 'README.md' }] }))
    const wrapper = mountPanel()
    await settle()
    await wrapper.find('[data-testid="workspace-diff-tab-pending"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-diff-pending-no-repo"]').exists()).toBe(true)

    await wrapper.find('[data-testid="workspace-diff-refresh"]').trigger('click')
    await settle()
    expect(mockedApi.getWorkspaceGitStatus).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="workspace-diff-pending-list"]').text()).toContain('README.md')
  })

  it('surfaces a git-status failure with a retry', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValue(checkpointView())
    mockedApi.getWorkspaceGitStatus
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(gitStatus())
    const wrapper = mountPanel()
    await settle()
    await wrapper.find('[data-testid="workspace-diff-tab-pending"]').trigger('click')

    expect(wrapper.find('[data-testid="workspace-diff-pending-error"]').text()).toContain('Failed to load the pending-commit status')
    await wrapper.find('[data-testid="workspace-diff-pending-retry"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-testid="workspace-diff-pending-list"]').text()).toContain('README.md')
  })

  it('keeps the run tab honest for degraded states and sessions without a snapshot', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValue(checkpointView({
      state: 'degraded',
      unrollableReason: 'GIT_UNAVAILABLE',
      changedCount: 0,
      changedFiles: [],
    }))
    mockedApi.getWorkspaceGitStatus.mockResolvedValue(gitStatus())
    const wrapper = mountPanel()
    await settle()
    expect(wrapper.find('[data-testid="workspace-diff-run-state"]').text()).toContain('cannot be rolled back')
    expect(wrapper.find('[data-testid="workspace-diff-run-clean"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-diff-run-entry"]').exists()).toBe(false)
  })

  it('surfaces a run-side projection failure with a retry', async () => {
    const RUN_LIVE = '55555555-5555-4555-8555-555555555555'
    const chatStore = useChatStore()
    chatStore.setSessionRunState(SESSION_ID, 'thinking', RUN_LIVE)
    mockedApi.getRunCheckpoint
      .mockRejectedValueOnce(new ApiError({
        status: 503,
        code: 'CHECKPOINT_UNAVAILABLE',
        detail: 'git unavailable',
        requestId: 'req-1',
      }))
      .mockResolvedValueOnce(checkpointView({ runId: RUN_LIVE, changedCount: 1 }))
    mockedApi.getWorkspaceGitStatus.mockResolvedValue(gitStatus())
    const wrapper = mountPanel()
    await settle()

    expect(wrapper.find('[data-testid="workspace-diff-run-error"]').text()).toContain('CHECKPOINT_UNAVAILABLE')
    await wrapper.find('[data-testid="workspace-diff-run-retry"]').trigger('click')
    await settle()
    expect(wrapper.find('[data-testid="workspace-diff-run-count"]').text()).toContain('1')
  })

  it('emits close from the panel close action', async () => {
    mockedApi.getRunCheckpoint.mockResolvedValue(checkpointView())
    mockedApi.getWorkspaceGitStatus.mockResolvedValue(gitStatus())
    const wrapper = mountPanel()
    await settle()
    await wrapper.find('[data-testid="workspace-changes-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('uses the live run id of the session when one is known', async () => {
    const chatStore = useChatStore()
    chatStore.setSessionRunState(SESSION_ID, 'thinking', RUN_ID)
    mockedApi.getRunCheckpoint.mockResolvedValue(checkpointView({ changedCount: 1 }))
    mockedApi.getWorkspaceGitStatus.mockResolvedValue(gitStatus())
    const wrapper = mountPanel()
    await settle()
    expect(mockedApi.getRunCheckpoint).toHaveBeenCalledWith(RUN_ID)
    expect(wrapper.find('[data-testid="workspace-diff-run-count"]').text()).toContain('1')
  })
})
