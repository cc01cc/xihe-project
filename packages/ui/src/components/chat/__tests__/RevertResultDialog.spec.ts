import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import { setActivePinia, createPinia } from 'pinia'
import RevertResultDialog from '../RevertResultDialog.vue'
import { api } from '../../../composables/api'
import type { RevertResult } from '../../../types'

vi.mock('../../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getRunCheckpointFile: vi.fn(),
      readFile: vi.fn(),
    },
  }
})

const mockedApi = vi.mocked(api, true)

const RUN_ID = '33333333-3333-4333-8333-333333333333'
const WORKSPACE_ID = '66666666-6666-4666-8666-666666666666'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      chat: {
        checkpointResultTitle: 'Restore result',
        checkpointResultDescription: 'Per-item outcomes',
        checkpointResultRestored: 'Restored',
        checkpointResultDeleted: 'Deleted',
        checkpointResultSkipped: 'Skipped (conflicts)',
        checkpointResultFailed: 'Failed',
        checkpointResultNoop: 'No action',
        checkpointResultUnknown: 'Unknown result',
        checkpointResultPartial: 'This was a partial restore',
        checkpointResultViewDiff: 'View diff',
        checkpointResultDiffLoading: 'Loading diff…',
        checkpointResultDiffFailed: 'Failed to load the diff',
        checkpointResultDiffEnd: 'snapshot content',
        checkpointResultDiffBase: 'snapshot baseline content',
        checkpointResultDiffTruncated: 'Content is long',
        checkpointResultAuditRef: 'Audit ref',
        checkpointResultDuration: 'Duration',
        checkpointResultRetry: 'Retry unfinished items',
        checkpointResultDismiss: 'Dismiss',
        checkpointConflictContentChanged: 'File changed after the run',
      },
      common: { close: 'Close' },
    },
  },
})

function result(overrides: Partial<RevertResult> = {}): RevertResult {
  return {
    runId: RUN_ID,
    revertRef: 'refs/xihe/run/rollback/1',
    counts: { restored: 1, deleted: 1, skippedConflict: 1, failed: 1, noop: 0 },
    entries: [
      { path: 'src/a.ts', result: 'restored' },
      { path: 'src/gone.ts', result: 'deleted' },
      { path: 'src/conflict.ts', result: 'skippedConflict', reason: 'CONTENT_CHANGED' },
      { path: 'src/broken.ts', result: 'failed', reason: 'WRITE_FAILED' },
    ],
    durationMs: 120,
    ...overrides,
  }
}

const wrappers: VueWrapper[] = []

function mountDialog(props: { show?: boolean; result?: RevertResult | null } = {}) {
  const wrapper = mount(RevertResultDialog, {
    props: { show: true, result: result(), ...props },
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
  setActivePinia(createPinia())
  localStorage.clear()
  localStorage.setItem('xihe-workspace', JSON.stringify({ id: WORKSPACE_ID, name: 'Workspace' }))
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
  localStorage.clear()
})

describe('RevertResultDialog', () => {
  it('groups outcomes and renders counts, duration and the audit ref', async () => {
    mountDialog()
    await settle()
    expect(bodyEl('revert-result-group-restored').textContent).toContain('src/a.ts')
    expect(bodyEl('revert-result-group-deleted').textContent).toContain('src/gone.ts')
    expect(bodyEl('revert-result-group-skippedConflict').textContent).toContain('src/conflict.ts')
    expect(bodyEl('revert-result-group-failed').textContent).toContain('src/broken.ts')
    expect(bodyEl('revert-result-counts').textContent).toContain('1')
    expect(bodyEl('revert-result-duration').textContent).toContain('120ms')
    expect(bodyEl('revert-result-ref').textContent).toContain('refs/xihe/run/rollback/1')
    expect(bodyEl('revert-result-partial')).toBeTruthy()
  })

  it('shows per-conflict reasons and offers retry only when items are unfinished', async () => {
    mountDialog()
    await settle()
    expect(bodyEl('revert-result-group-skippedConflict').textContent).toContain('File changed after the run')
    expect(bodyEl('revert-result-retry').textContent).toContain('(2)')
    expect(bodyEl('revert-result-dismiss')).toBeTruthy()
  })

  it('hides retry when every item completed, and keeps unknown results in a separate group', async () => {
    mountDialog({
      result: result({
        counts: { restored: 1, deleted: 0, skippedConflict: 0, failed: 0, noop: 0 },
        entries: [
          { path: 'src/a.ts', result: 'restored' },
          { path: 'src/odd.ts', result: 'unknown', reason: '???' },
        ],
      }),
    })
    await settle()
    expect(document.body.querySelector('[data-testid="revert-result-retry"]')).toBeNull()
    expect(bodyEl('revert-result-group-unknown').textContent).toContain('src/odd.ts')
  })

  it('emits retry with the run id and close on dismiss', async () => {
    const wrapper = mountDialog()
    await settle()
    bodyEl('revert-result-retry').click()
    await settle()
    expect(wrapper.emitted('retry')).toEqual([[RUN_ID]])
    bodyEl('revert-result-dismiss').click()
    await settle()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('loads the checkpoint side and the current content for 查看差异 and renders a line diff', async () => {
    mockedApi.getRunCheckpointFile.mockResolvedValueOnce('line one\nold line\n')
    mockedApi.readFile.mockResolvedValueOnce({ content: 'line one\nnew line\n' })
    mountDialog()
    await settle()
    bodyEl('revert-result-diff-src/conflict.ts').click()
    await settle()
    expect(mockedApi.getRunCheckpointFile).toHaveBeenCalledWith(RUN_ID, 'src/conflict.ts', 'end')
    expect(mockedApi.readFile).toHaveBeenCalledWith('src/conflict.ts', WORKSPACE_ID)
    expect(bodyEl('revert-result-diff-panel').textContent).toContain('snapshot content')
    const rows = bodyEl('revert-result-diff-rows')
    expect(rows.textContent).toContain('old line')
    expect(rows.textContent).toContain('new line')
    expect(rows.querySelectorAll('div')).toHaveLength(4)
  })

  it('falls back to the base ref when the end blob is missing', async () => {
    mockedApi.getRunCheckpointFile
      .mockRejectedValueOnce(new Error('CHECKPOINT_NOT_FOUND'))
      .mockResolvedValueOnce('base content')
    mockedApi.readFile.mockResolvedValueOnce({ content: 'base content' })
    mountDialog()
    await settle()
    bodyEl('revert-result-diff-src/broken.ts').click()
    await settle()
    expect(mockedApi.getRunCheckpointFile.mock.calls).toEqual([
      [RUN_ID, 'src/broken.ts', 'end'],
      [RUN_ID, 'src/broken.ts', 'base'],
    ])
    expect(bodyEl('revert-result-diff-panel').textContent).toContain('snapshot baseline content')
  })

  it('surfaces a diff load failure', async () => {
    mockedApi.getRunCheckpointFile.mockRejectedValueOnce(new Error('blob unavailable'))
    mockedApi.readFile.mockResolvedValueOnce({ content: 'x' })
    mountDialog()
    await settle()
    bodyEl('revert-result-diff-src/conflict.ts').click()
    await settle()
    expect(bodyEl('revert-result-diff-error')).toBeTruthy()
  })
})
