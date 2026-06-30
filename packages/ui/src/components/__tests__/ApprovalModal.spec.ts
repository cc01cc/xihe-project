import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ApprovalModal from '../chat/ApprovalModal.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { chat: { approve: 'Approve', reject: 'Reject' } } },
})

function mountModal(props: any) {
  return mount(ApprovalModal, { props, global: { plugins: [i18n] } })
}

const mockToolCall = {
  id: 'tc-1',
  name: 'read_file',
  arguments: '{"path":"/test.txt"}',
  status: 'pending' as const,
}

describe('ApprovalModal', () => {
  it('renders when show is true', () => {
    const wrapper = mountModal({ toolCall: mockToolCall, show: true })
    expect(wrapper.text()).toContain('read_file')
  })

  it('does not render when show is false', () => {
    const wrapper = mountModal({ toolCall: mockToolCall, show: false })
    expect(wrapper.find('[class*="fixed"]').exists()).toBe(false)
  })

  it('shows tool arguments', () => {
    const wrapper = mountModal({ toolCall: mockToolCall, show: true })
    expect(wrapper.text()).toContain('/test.txt')
  })

  it('emits approve on approve button click', async () => {
    const wrapper = mountModal({ toolCall: mockToolCall, show: true })
    const approveBtn = wrapper.findAll('button').filter(b => b.text().includes('Approve'))
    if (approveBtn.length) await approveBtn[0].trigger('click')
    expect(wrapper.emitted('approve')).toBeTruthy()
  })

  it('emits reject on reject button click', async () => {
    const wrapper = mountModal({ toolCall: mockToolCall, show: true })
    const rejectBtn = wrapper.findAll('button').filter(b => b.text().includes('Reject'))
    if (rejectBtn.length) await rejectBtn[0].trigger('click')
    expect(wrapper.emitted('reject')).toBeTruthy()
  })
})
