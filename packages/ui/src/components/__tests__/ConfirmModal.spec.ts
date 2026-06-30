import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmModal from '../shared/ConfirmModal.vue'

describe('ConfirmModal', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('renders title and description', () => {
    const wrapper = mount(ConfirmModal, {
      props: { show: true, title: 'Delete?', description: 'This cannot be undone' },
    })
    expect(wrapper.text()).toContain('Delete?')
    expect(wrapper.text()).toContain('This cannot be undone')
  })

  it('emits confirm on confirm button click', async () => {
    const wrapper = mount(ConfirmModal, {
      props: { show: true, title: 'Confirm' },
    })
    const confirmBtn = wrapper.findAll('button').filter(b => b.text().includes('Confirm'))
    if (confirmBtn.length) await confirmBtn[0].trigger('click')
    expect(wrapper.emitted('confirm')).toBeTruthy()
  })

  it('emits cancel on cancel button click', async () => {
    const wrapper = mount(ConfirmModal, {
      props: { show: true, title: 'Confirm' },
    })
    const cancelBtn = wrapper.findAll('button').filter(b => b.text().includes('Cancel'))
    if (cancelBtn.length) await cancelBtn[0].trigger('click')
    expect(wrapper.emitted('cancel')).toBeTruthy()
  })

  it('auto-closes after 1.5s on confirm', async () => {
    const wrapper = mount(ConfirmModal, {
      props: { show: true, title: 'Confirm' },
    })
    const confirmBtn = wrapper.findAll('button').filter(b => b.text().includes('Confirm'))
    if (confirmBtn.length) await confirmBtn[0].trigger('click')
    expect(wrapper.emitted('confirm')).toBeTruthy()
    vi.advanceTimersByTime(1500)
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('shows destructive style when destructive prop is true', () => {
    const wrapper = mount(ConfirmModal, {
      props: { show: true, title: 'Delete?', destructive: true },
    })
    expect(wrapper.html()).toContain('bg-destructive')
  })
})
