import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ApprovalModal from '../chat/ApprovalModal.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      chat: { approve: 'Approve', reject: 'Reject', approvalRequired: 'Approval Required', reviewApproval: 'Review approval' },
      common: { saving: 'Saving...' },
    },
  },
})

function mountModal(props: any) {
  return mount(ApprovalModal, { props, global: { plugins: [i18n] } })
}

const mockApproval = {
  requestId: 'approval-1',
  runId: 'run-1',
  sessionId: 'session-1',
  tool: 'request_approval',
  action: 'read file',
  details: '/test.txt',
  state: 'pending' as const,
}

describe('ApprovalModal', () => {
  it('renders when show is true', () => {
    const wrapper = mountModal({ approval: mockApproval, show: true })
    expect(wrapper.text()).toContain('request_approval')
  })

  it('does not render when show is false', () => {
    const wrapper = mountModal({ approval: mockApproval, show: false })
    expect(wrapper.find('[class*="fixed"]').exists()).toBe(false)
  })

  it('shows tool arguments', () => {
    const wrapper = mountModal({ approval: mockApproval, show: true })
    expect(wrapper.text()).toContain('/test.txt')
  })

  it('emits approve on approve button click', async () => {
    const wrapper = mountModal({ approval: mockApproval, show: true })
    const approveBtn = wrapper.findAll('button').filter(b => b.text().includes('Approve'))
    if (approveBtn.length) await approveBtn[0].trigger('click')
    expect(wrapper.emitted('approve')).toBeTruthy()
  })

  it('emits reject on reject button click', async () => {
    const wrapper = mountModal({ approval: mockApproval, show: true })
    const rejectBtn = wrapper.findAll('button').filter(b => b.text().includes('Reject'))
    if (rejectBtn.length) await rejectBtn[0].trigger('click')
    expect(wrapper.emitted('reject')).toBeTruthy()
  })

  // Scripted human-in-the-loop flow: each decision carries its own request id.
  it('scripted flow: approve then reject carries per-decision ids', async () => {
    const wrapper = mountModal({ approval: mockApproval, show: true }),
      approveBtn = wrapper.findAll('button').filter(b => b.text().includes('Approve'))
    expect(approveBtn.length).toBeGreaterThan(0)
    await approveBtn[0].trigger('click')
    expect(wrapper.emitted('approve')![0]).toEqual(['approval-1'])

    const approval2 = { ...mockApproval, requestId: 'approval-2', tool: 'request_approval', action: 'write file' }
    await wrapper.setProps({ approval: approval2, show: true })
    const rejectBtn = wrapper.findAll('button').filter(b => b.text().includes('Reject'))
    expect(rejectBtn.length).toBeGreaterThan(0)
    await rejectBtn[0].trigger('click')
    expect(wrapper.emitted('reject')![0]).toEqual(['approval-2'])
    expect(wrapper.emitted('approve')).toHaveLength(1)
  })
})
