import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ToolCallCard from '../chat/ToolCallCard.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { chat: { toolStatus: { pending: 'Pending', running: 'Running', completed: 'Completed', failed: 'Failed', approved: 'Approved', rejected: 'Rejected' }, approve: 'Approve', reject: 'Reject', toolDiagnosticsTitle: 'Diagnostics', toolDiagnosticsSummary: '{total} total, {shown} shown', toolDiagnosticsMore: '{count} more', toolRawOutput: 'Raw output' } } },
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
