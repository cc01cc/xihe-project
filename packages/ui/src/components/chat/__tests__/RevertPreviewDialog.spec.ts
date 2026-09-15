import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import RevertPreviewDialog from '../RevertPreviewDialog.vue'
import { ApiError, api } from '../../../composables/api'
import type { RevertPreview } from '../../../types'

vi.mock('../../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      previewRunCheckpointRevert: vi.fn(),
    },
  }
})

const mockedApi = vi.mocked(api, true)

const RUN_ID = '33333333-3333-4333-8333-333333333333'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      chat: {
        checkpointPreviewTitle: 'Restore this run',
        checkpointPreviewDescription: 'Dry-run preview',
        checkpointPreviewLoading: 'Building the revert preview…',
        checkpointPreviewFailed: 'Failed to load the revert preview',
        checkpointPreviewRetry: 'Retry',
        checkpointPreviewRestore: 'Will restore',
        checkpointPreviewDelete: 'Will delete',
        checkpointPreviewSkipConflicts: 'Will skip (conflicts)',
        checkpointPreviewNoop: 'No action',
        checkpointPreviewCountsUnavailable: 'Preview projection incomplete',
        checkpointPreviewPathsTitle: 'Paths',
        checkpointPreviewExpand: 'Show all',
        checkpointPreviewCollapse: 'Collapse',
        checkpointPreviewTruncated: 'Plan is long',
        checkpointPreviewConflictBadge: 'Conflict',
        checkpointPreviewConflictAck: 'I understand conflicts are not restored',
        checkpointPreviewConflictIncomplete: 'Conflict paths incomplete',
        checkpointPreviewHeadChanged: 'HEAD changed',
        checkpointPreviewHeadUnknown: 'HEAD status unknown',
        checkpointPreviewHeadAck: 'I still want to restore',
        checkpointPreviewLiveJobs: 'Jobs were running at seal time',
        checkpointPreviewNoEntries: 'No paths need restoring.',
        checkpointPreviewConfirm: 'Execute restore',
        checkpointConflictContentChanged: 'File changed after the run',
        checkpointEntryRestore: 'Restore',
        checkpointEntryDelete: 'Delete',
        checkpointEntryUnknownAction: 'Unknown action',
      },
      common: { cancel: 'Cancel' },
    },
  },
})

function preview(overrides: Partial<RevertPreview> = {}): RevertPreview {
  return {
    runId: RUN_ID,
    state: 'sealed',
    counts: { restore: 2, delete: 1, skipConflicts: 0, noop: 0 },
    entries: [
      { path: 'src/a.ts', action: 'restore' },
      { path: 'src/b.ts', action: 'delete' },
    ],
    headFingerprint: { recorded: 'abc', current: 'abc', status: 'ok' },
    sealedWithLiveJobs: false,
    truncated: false,
    ...overrides,
  }
}

const wrappers: VueWrapper[] = []

function mountDialog(props: { show?: boolean; runId?: string; busy?: boolean; error?: string | null } = {}) {
  const wrapper = mount(RevertPreviewDialog, {
    props: { show: true, runId: RUN_ID, ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  wrappers.push(wrapper)
  return wrapper
}

function bodyEl(testid: string): HTMLElement {
  const el = document.body.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
  if (!el) throw new Error(`missing element ${testid}`)
  return el
}

async function settle() {
  await flushPromises()
  await nextTick()
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
})

describe('RevertPreviewDialog', () => {
  it('loads the dry-run preview on open and renders counts and paths', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview())
    const wrapper = mountDialog()
    await settle()
    expect(mockedApi.previewRunCheckpointRevert).toHaveBeenCalledWith(RUN_ID)
    expect(bodyEl('revert-preview-restore-count').textContent).toBe('2')
    expect(bodyEl('revert-preview-delete-count').textContent).toBe('1')
    expect(bodyEl('revert-preview-skip-count').textContent).toBe('0')
    expect(bodyEl('revert-preview-paths').textContent).toContain('src/a.ts')
    expect(bodyEl('revert-preview-paths').textContent).toContain('src/b.ts')
    expect(wrapper.isVisible()).toBe(true)
  })

  it('defaults focus to cancel (not the destructive confirm)', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview())
    mountDialog()
    await settle()
    expect(document.activeElement).toBe(bodyEl('revert-preview-cancel'))
  })

  it('gates the submit on the conflict acknowledgement and sends the conflict paths', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview({
      counts: { restore: 1, delete: 0, skipConflicts: 1, noop: 1 },
      entries: [
        { path: 'src/a.ts', action: 'restore' },
        { path: 'src/conflict.ts', action: 'restore', conflictReason: 'CONTENT_CHANGED' },
      ],
    }))
    const wrapper = mountDialog()
    await settle()
    const confirm = bodyEl('revert-preview-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    bodyEl('revert-preview-conflict-ack').click()
    await settle()
    expect(confirm.disabled).toBe(false)
    confirm.click()
    await settle()
    expect(wrapper.emitted('confirm')).toEqual([[
      { acknowledgeConflicts: ['src/conflict.ts'], acknowledgeHeadChange: false },
    ]])
  })

  it('shows the conflict reason on the affected entry', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview({
      counts: { restore: 1, delete: 0, skipConflicts: 1, noop: 0 },
      entries: [{ path: 'src/conflict.ts', action: 'restore', conflictReason: 'CONTENT_CHANGED' }],
    }))
    mountDialog()
    await settle()
    expect(bodyEl('revert-preview-conflict').textContent).toContain('Conflict')
    expect(bodyEl('revert-preview-conflict').textContent).toContain('File changed after the run')
  })

  it('requires an explicit head-change acknowledgement when the fingerprint changed', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview({
      headFingerprint: { recorded: 'abc', current: 'def', status: 'changed' },
    }))
    const wrapper = mountDialog()
    await settle()
    expect(bodyEl('revert-preview-head-warning').textContent).toContain('HEAD changed')
    const confirm = bodyEl('revert-preview-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    bodyEl('revert-preview-head-ack').click()
    await settle()
    expect(confirm.disabled).toBe(false)
    confirm.click()
    await settle()
    expect(wrapper.emitted('confirm')).toEqual([[
      { acknowledgeConflicts: [], acknowledgeHeadChange: true },
    ]])
  })

  it('requires the head acknowledgement when the fingerprint status is unknown', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview({
      headFingerprint: { recorded: null, current: null, status: 'unknown' },
    }))
    mountDialog()
    await settle()
    expect(bodyEl('revert-preview-head-warning').textContent).toContain('HEAD status unknown')
    expect((bodyEl('revert-preview-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not require a head acknowledgement when the workspace is not a repository', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview({
      headFingerprint: { recorded: null, current: null, status: 'not_repo' },
    }))
    mountDialog()
    await settle()
    expect(document.body.querySelector('[data-testid="revert-preview-head-warning"]')).toBeNull()
    expect((bodyEl('revert-preview-confirm') as HTMLButtonElement).disabled).toBe(false)
  })

  it('blocks the submit when the counts projection is incomplete', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview({ counts: null }))
    mountDialog()
    await settle()
    expect(bodyEl('revert-preview-counts-unavailable')).toBeTruthy()
    expect((bodyEl('revert-preview-confirm') as HTMLButtonElement).disabled).toBe(true)
  })

  it('blocks the submit when a truncated preview cannot enumerate every conflict', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview({
      counts: { restore: 1, delete: 0, skipConflicts: 2, noop: 0 },
      entries: [{ path: 'src/a.ts', action: 'restore', conflictReason: 'CONTENT_CHANGED' }],
      truncated: true,
    }))
    mountDialog()
    await settle()
    expect(bodyEl('revert-preview-conflict-incomplete')).toBeTruthy()
    expect((bodyEl('revert-preview-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect(bodyEl('revert-preview-truncated')).toBeTruthy()
  })

  it('collapses path lists longer than 20 entries and expands on demand', async () => {
    const entries = Array.from({ length: 25 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      action: 'restore' as const,
    }))
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview({
      counts: { restore: 25, delete: 0, skipConflicts: 0, noop: 0 },
      entries,
    }))
    const wrapper = mountDialog()
    await settle()
    expect(bodyEl('revert-preview-paths').querySelectorAll('li')).toHaveLength(20)
    bodyEl('revert-preview-expand').click()
    await settle()
    expect(bodyEl('revert-preview-paths').querySelectorAll('li')).toHaveLength(25)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('surfaces a load failure with a retry that refetches', async () => {
    mockedApi.previewRunCheckpointRevert.mockRejectedValueOnce(new ApiError({
      status: 409,
      code: 'CHECKPOINT_HEAD_CHANGED',
      detail: 'the workspace HEAD changed',
      requestId: 'req-1',
    }))
    mountDialog()
    await settle()
    expect(bodyEl('revert-preview-error').textContent).toContain('CHECKPOINT_HEAD_CHANGED')
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview())
    bodyEl('revert-preview-retry').click()
    await settle()
    expect(mockedApi.previewRunCheckpointRevert).toHaveBeenCalledTimes(2)
    expect(bodyEl('revert-preview-restore-count').textContent).toBe('2')
  })

  it('emits close from cancel without emitting confirm', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview())
    const wrapper = mountDialog()
    await settle()
    bodyEl('revert-preview-cancel').click()
    await settle()
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(wrapper.emitted('confirm')).toBeUndefined()
  })

  it('shows the live-jobs caveat and the submit error, and disables actions while busy', async () => {
    mockedApi.previewRunCheckpointRevert.mockResolvedValueOnce(preview({ sealedWithLiveJobs: true }))
    mountDialog({ busy: true, error: 'CHECKPOINT_LEASE_HELD: another run holds the lease' })
    await settle()
    expect(bodyEl('revert-preview-live-jobs').textContent).toContain('Jobs were running at seal time')
    expect(bodyEl('revert-preview-submit-error').textContent).toContain('CHECKPOINT_LEASE_HELD')
    expect((bodyEl('revert-preview-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect((bodyEl('revert-preview-cancel') as HTMLButtonElement).disabled).toBe(true)
  })
})
