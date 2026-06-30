import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ToolCallCard from '../chat/ToolCallCard.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { chat: { toolStatus: { pending: 'Pending', running: 'Running', completed: 'Completed', failed: 'Failed', approved: 'Approved', rejected: 'Rejected' }, approve: 'Approve', reject: 'Reject' } } },
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
})
