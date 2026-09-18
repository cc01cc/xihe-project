import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ToolCallCard from '../chat/ToolCallCard.vue'

const getJobOutput = vi.fn()
const cancelJob = vi.fn()
vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getJobOutput: (...args: unknown[]) => getJobOutput(...args),
      cancelJob: (...args: unknown[]) => cancelJob(...args),
    },
  }
})

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { chat: { toolStatus: { pending: 'Pending', running: 'Running', completed: 'Completed', failed: 'Failed', approved: 'Approved', rejected: 'Rejected' }, approve: 'Approve', reject: 'Reject', toolDiagnosticsTitle: 'Diagnostics', toolDiagnosticsSummary: '{total} total, {shown} shown', toolDiagnosticsMore: '{count} more', toolRawOutput: 'Raw output', jobOutputTitle: 'Background job output', jobOutputLoad: 'View output', jobOutputReload: 'Reload', jobOutputMore: 'Load more', jobOutputEmpty: '(no output yet)', jobOutputTruncated: 'Output reached the 1 MiB cap', jobOutputLost: 'Job output is no longer available', jobOutputExpired: 'Job output expired', jobOutputUnavailable: 'Runtime unavailable', jobCancelButton: 'Cancel this job', jobCancelHint: 'Only this job is terminated; the conversation continues', jobCancelConfirmHint: 'Cancel this job ({jobId})? Its output is kept and the run continues.', jobCancelConfirm: 'Confirm cancel', jobCancelBack: 'Back', jobCancelPending: 'Cancelling…', jobCancelDone: 'Cancelled: the job was terminated; this conversation continues.', jobCancelOrphaned: 'The job is gone; the archive was closed as orphaned.', jobCancelUnconfirmed: 'Cancellation unconfirmed: the process may still be running; retry later', jobCancelUnavailable: 'Runtime is temporarily unavailable; try again later', jobStatus: { running: 'Running', succeeded: 'Succeeded', cancelled: 'Cancelled', timeout: 'Timeout', orphaned: 'Orphaned' } } } },
})

function mountCard(props: any) {
  return mount(ToolCallCard, { props, global: { plugins: [i18n] } })
}

function makeToolCall(overrides = {}) {
  return {
    id: 'tc-1',
    name: 'read_file',
    arguments: JSON.stringify({ path: '/test.txt' }),
    status: 'running',
    startedAt: new Date().toISOString(),
    ...overrides,
  }
}

function makeDiagnostics(count = 5) {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      file: `src/file-${index}.ts`,
      line: index + 1,
      column: 2,
      severity: index === 0 ? 'error' : index === 1 ? 'warning' : 'note',
      kind: 'compile',
      message: `problem ${index}`,
      confidence: 'high',
    })),
    total: count,
    confidence: 'high',
  }
}

describe('ToolCallCard', () => {
  it('renders tool name', () => {
    const wrapper = mountCard({ toolCall: makeToolCall() })
    expect(wrapper.text()).toContain('read_file')
  })

  it('shows duration when completed', () => {
    const startedAt = new Date(Date.now() - 1500).toISOString()
    const completedAt = new Date().toISOString()
    const wrapper = mountCard({ toolCall: makeToolCall({ status: 'completed', startedAt, completedAt }) })
    expect(wrapper.text()).toMatch(/\d+\.?\d*s/)
  })

  it('emits approve when approve button clicked', async () => {
    const wrapper = mountCard({ toolCall: makeToolCall({ status: 'pending' }) })
    // Click header to expand
    await wrapper.find('button').trigger('click')
    // Click approve button inside expanded view
    await wrapper.findAll('button').filter(b => b.text() === 'Approve')[0]?.trigger('click')
    expect(wrapper.emitted('approve')).toBeTruthy()
  })

  it('emits reject when reject button clicked', async () => {
    const wrapper = mountCard({ toolCall: makeToolCall({ status: 'pending' }) })
    await wrapper.find('button').trigger('click')
    await wrapper.findAll('button').filter(b => b.text() === 'Reject')[0]?.trigger('click')
    expect(wrapper.emitted('reject')).toBeTruthy()
  })

  it('shows error message when present', async () => {
    const wrapper = mountCard({ toolCall: makeToolCall({ status: 'failed', error: 'Connection refused' }) })
    await wrapper.find('button').trigger('click')
    expect(wrapper.text()).toContain('Connection refused')
  })

  it('truncates result longer than 2000 chars', async () => {
    const result = 'x'.repeat(2500)
    const wrapper = mountCard({ toolCall: makeToolCall({ status: 'completed', result }) })
    await wrapper.find('button').trigger('click')
    expect(wrapper.text()).toContain('truncated')
  })

  it('keeps the legacy collapsed card when there are no diagnostics', () => {
    const wrapper = mountCard({ toolCall: makeToolCall({ status: 'completed', result: 'done' }) })
    expect(wrapper.find('[data-testid="tool-diagnostics"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="raw-output-toggle"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('done')
  })

  it('auto-expands and shows the first three diagnostics with the count summary', () => {
    const wrapper = mountCard({
      toolCall: makeToolCall({ status: 'completed', diagnostics: makeDiagnostics(5) }),
    })

    expect(wrapper.find('[data-testid="tool-diagnostics"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid^="diagnostic-item-"]')).toHaveLength(3)
    expect(wrapper.text()).toContain('src/file-0.ts:1:2')
    expect(wrapper.text()).toContain('problem 0')
    expect(wrapper.text()).toContain('5 total, 5 shown')
    expect(wrapper.find('[data-testid="diagnostics-more"]').text()).toContain('2 more')
    expect(wrapper.find('[data-testid="diagnostics-more"]').attributes('aria-expanded')).toBe('false')
  })

  it('reveals all diagnostics when the more button is clicked', async () => {
    const wrapper = mountCard({
      toolCall: makeToolCall({ status: 'completed', diagnostics: makeDiagnostics(5) }),
    })

    await wrapper.find('[data-testid="diagnostics-more"]').trigger('click')

    expect(wrapper.findAll('[data-testid^="diagnostic-item-"]')).toHaveLength(5)
    expect(wrapper.find('[data-testid="diagnostics-more"]').exists()).toBe(false)
  })

  it('does not show the more button for three or fewer diagnostics', () => {
    const wrapper = mountCard({
      toolCall: makeToolCall({ status: 'completed', diagnostics: makeDiagnostics(3) }),
    })
    expect(wrapper.find('[data-testid="diagnostics-more"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid^="diagnostic-item-"]')).toHaveLength(3)
  })

  it('keeps the raw output collapsed behind its own toggle', async () => {
    const wrapper = mountCard({
      toolCall: makeToolCall({
        status: 'completed',
        result: 'raw failure output',
        diagnostics: makeDiagnostics(1),
      }),
    })

    const toggle = wrapper.find('[data-testid="raw-output-toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.text()).not.toContain('raw failure output')

    await toggle.trigger('click')

    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.text()).toContain('raw failure output')
  })

  it('uses the destructive color for errors and a muted color for warnings and notes', () => {
    const wrapper = mountCard({
      toolCall: makeToolCall({ status: 'completed', diagnostics: makeDiagnostics(3) }),
    })

    expect(wrapper.find('[data-testid="diagnostic-item-0"] .text-destructive').exists()).toBe(true)
    expect(wrapper.find('[data-testid="diagnostic-item-1"] .text-muted-foreground').exists()).toBe(true)
    expect(wrapper.find('[data-testid="diagnostic-item-2"] .text-muted-foreground').exists()).toBe(true)
  })
})

describe('ToolCallCard job output (PLAN-0344)', () => {
  beforeEach(() => {
    getJobOutput.mockReset()
  })

  function jobToolCall(overrides = {}) {
    return makeToolCall({
      name: 'start_background_process',
      status: 'running',
      jobSummary: {
        itemId: 'item-1',
        jobId: 'job-1',
        status: 'running',
        toolName: 'start_background_process',
        scope: 'session',
      },
      ...overrides,
    })
  }

  it('renders job panel and pages output by byte cursor', async () => {
    getJobOutput
      .mockResolvedValueOnce({
        jobId: 'job-1', stream: 'stdout', offset: 0, nextOffset: 6,
        sizeBytes: 12, truncated: false, data: 'line1\n', jobStatus: 'running',
      })
      .mockResolvedValueOnce({
        jobId: 'job-1', stream: 'stdout', offset: 6, nextOffset: 12,
        sizeBytes: 12, truncated: false, data: 'line2\n', jobStatus: 'running',
      })

    const wrapper = mountCard({ toolCall: jobToolCall() })
    await wrapper.find('[data-testid="tool-card-toggle"]').trigger('click')

    expect(wrapper.find('[data-testid="job-output-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="job-status"]').text()).toBe('Running')

    await wrapper.find('[data-testid="job-output-load"]').trigger('click')
    await flushPromises()
    expect(getJobOutput).toHaveBeenCalledWith('item-1', expect.objectContaining({ offset: 0 }))
    expect(wrapper.find('[data-testid="job-output-data"]').text()).toContain('line1')

    await wrapper.find('[data-testid="job-output-more"]').trigger('click')
    await flushPromises()
    expect(getJobOutput).toHaveBeenLastCalledWith('item-1', expect.objectContaining({ offset: 6 }))
    expect(wrapper.find('[data-testid="job-output-data"]').text()).toContain('line2')
    expect(wrapper.find('[data-testid="job-output-more"]').exists()).toBe(false)
  })

  it('maps terminal failures to explicit messages', async () => {
    const { ApiError } = await import('../../composables/api')
    getJobOutput.mockRejectedValueOnce(
      new ApiError({
        type: 'https://xihe.dev/problems/output-expired',
        title: 'Conflict',
        status: 409,
        detail: 'output expired',
        code: 'JOB_OUTPUT_EXPIRED',
        requestId: 'req-1',
      }),
    )

    const wrapper = mountCard({
      toolCall: jobToolCall({
        status: 'completed',
        jobSummary: { itemId: 'item-1', jobId: 'job-1', status: 'succeeded', toolName: 'start_background_process' },
      }),
    })
    await wrapper.find('[data-testid="tool-card-toggle"]').trigger('click')
    await wrapper.find('[data-testid="job-output-load"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="job-output-error"]').text()).toContain('expired')
  })

  it('hides the panel for non-job tools without a summary', async () => {
    const wrapper = mountCard({ toolCall: makeToolCall({ status: 'completed' }) })
    await wrapper.find('[data-testid="tool-card-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="job-output-panel"]').exists()).toBe(false)
  })
})

describe('ToolCallCard job cancel (PLAN-0366 T2.2)', () => {
  beforeEach(() => {
    cancelJob.mockReset()
    getJobOutput.mockReset()
  })

  function jobToolCall(overrides = {}) {
    return makeToolCall({
      name: 'start_background_process',
      status: 'running',
      jobSummary: {
        itemId: 'item-1',
        jobId: 'job-1',
        status: 'running',
        toolName: 'start_background_process',
        scope: 'session',
      },
      ...overrides,
    })
  }

  async function expandJobCard(props: any) {
    const wrapper = mountCard(props)
    await wrapper.find('[data-testid="tool-card-toggle"]').trigger('click')
    return wrapper
  }

  it('only enables the cancel button for a running job', async () => {
    const running = await expandJobCard({ toolCall: jobToolCall() })
    expect(running.find('[data-testid="job-cancel-button"]').attributes('disabled')).toBeUndefined()

    const terminal = await expandJobCard({
      toolCall: jobToolCall({
        status: 'completed',
        jobSummary: { itemId: 'item-1', jobId: 'job-1', status: 'succeeded' },
      }),
    })
    expect(terminal.find('[data-testid="job-cancel-button"]').attributes('disabled')).toBeDefined()
  })

  it('requires a second confirmation before calling the endpoint', async () => {
    cancelJob.mockResolvedValue({ itemId: 'item-1', jobId: 'job-1', status: 'cancelled', changed: true })
    const wrapper = await expandJobCard({ toolCall: jobToolCall() })

    await wrapper.find('[data-testid="job-cancel-button"]').trigger('click')
    expect(cancelJob).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="job-cancel-confirm-hint"]').text()).toContain('job-1')

    await wrapper.find('[data-testid="job-cancel-back"]').trigger('click')
    expect(wrapper.find('[data-testid="job-cancel-confirm"]').exists()).toBe(false)

    await wrapper.find('[data-testid="job-cancel-button"]').trigger('click')
    await wrapper.find('[data-testid="job-cancel-confirm"]').trigger('click')
    await flushPromises()

    expect(cancelJob).toHaveBeenCalledWith('item-1')
    expect(wrapper.find('[data-testid="job-status"]').text()).toBe('Cancelled')
    expect(wrapper.find('[data-testid="job-cancel-success"]').text()).toContain('Cancelled')
  })

  it('blocks repeat submissions while the request is pending', async () => {
    cancelJob.mockReturnValue(new Promise(() => {}))
    const wrapper = await expandJobCard({ toolCall: jobToolCall() })

    await wrapper.find('[data-testid="job-cancel-button"]').trigger('click')
    await wrapper.find('[data-testid="job-cancel-confirm"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="job-cancel-pending"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="job-cancel-button"]').attributes('disabled')).toBeDefined()
    expect(cancelJob).toHaveBeenCalledTimes(1)
  })

  it('maps JOB_CANCEL_UNCONFIRMED to an explicit retryable message and keeps the status', async () => {
    const { ApiError } = await import('../../composables/api')
    cancelJob.mockRejectedValueOnce(
      new ApiError({
        type: 'https://xihe.dev/problems/job-cancel-unconfirmed',
        title: 'Bad Gateway',
        status: 502,
        detail: 'unconfirmed',
        code: 'JOB_CANCEL_UNCONFIRMED',
        requestId: 'req-1',
      }),
    )
    const wrapper = await expandJobCard({ toolCall: jobToolCall() })

    await wrapper.find('[data-testid="job-cancel-button"]').trigger('click')
    await wrapper.find('[data-testid="job-cancel-confirm"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="job-cancel-error"]').text()).toContain('unconfirmed')
    expect(wrapper.find('[data-testid="job-status"]').text()).toBe('Running')
    // 失败后按钮回到可重试状态
    expect(wrapper.find('[data-testid="job-cancel-button"]').attributes('disabled')).toBeUndefined()
  })

  it('maps RUNTIME_UNAVAILABLE to the unavailable message', async () => {
    const { ApiError } = await import('../../composables/api')
    cancelJob.mockRejectedValueOnce(
      new ApiError({
        type: 'https://xihe.dev/problems/runtime-unavailable',
        title: 'Bad Gateway',
        status: 502,
        detail: 'unreachable',
        code: 'RUNTIME_UNAVAILABLE',
        requestId: 'req-2',
      }),
    )
    const wrapper = await expandJobCard({ toolCall: jobToolCall() })

    await wrapper.find('[data-testid="job-cancel-button"]').trigger('click')
    await wrapper.find('[data-testid="job-cancel-confirm"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="job-cancel-error"]').text()).toContain('temporarily unavailable')
  })
})
