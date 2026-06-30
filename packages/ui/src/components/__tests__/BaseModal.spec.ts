import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import BaseModal from '../shared/BaseModal.vue'

describe('BaseModal', () => {
  it('renders when show is true', () => {
    const wrapper = mount(BaseModal, {
      props: { show: true, title: 'Test Modal' },
      slots: { default: 'Content here' },
    })
    expect(wrapper.text()).toContain('Test Modal')
    expect(wrapper.text()).toContain('Content here')
  })

  it('does not render when show is false', () => {
    const wrapper = mount(BaseModal, {
      props: { show: false, title: 'Test' },
    })
    expect(wrapper.find('[class*="fixed"]').exists()).toBe(false)
  })

  // Note: backdrop click test skipped due to Teleport limitation in jsdom.
  // Tested manually in Playwright E2E.

  it('renders close button with aria-label', () => {
    const wrapper = mount(BaseModal, {
      props: { show: true, title: 'Test' },
    })
    const closeBtn = wrapper.find('button[aria-label="Close"]')
    expect(closeBtn.exists()).toBe(true)
  })
})
