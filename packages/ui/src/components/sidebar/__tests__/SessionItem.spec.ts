import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionItem from '../SessionItem.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

describe('SessionItem', () => {
  it('renders title and time', () => {
    const session = { id: 's1', title: 'My Chat', updatedAt: new Date().toISOString() }
    const wrapper = mount(SessionItem, {
      props: { session, isActive: false },
    })
    expect(wrapper.text()).toContain('My Chat')
  })

  it('applies active class when isActive is true', () => {
    const session = { id: 's1', title: 'Active', updatedAt: new Date().toISOString() }
    const wrapper = mount(SessionItem, {
      props: { session, isActive: true },
    })
    const classes = wrapper.find('div').classes()
    const hasActive = classes.some((c: string) => c.includes('active') || c.includes('Active') || c.includes('bg-'))
    expect(hasActive).toBe(true)
  })

  it('renders clickable session', () => {
    const session = { id: 's1', title: 'Clickable', updatedAt: new Date().toISOString() }
    const wrapper = mount(SessionItem, {
      props: { session, isActive: false },
    })
    expect(wrapper.text()).toContain('Clickable')
    expect(wrapper.find('div').exists()).toBe(true)
  })

  it('renders a non-interactive pending approval badge with its count', () => {
    const session = { id: 's1', title: 'Pending', updatedAt: new Date().toISOString() }
    const wrapper = mount(SessionItem, {
      props: { session, isActive: false, pendingCount: 2 },
    })

    const badge = wrapper.find('[data-testid="session-pending-badge"]')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toContain('sidebar.pendingApprovalBadge')
    expect(badge.text()).toContain('2')
    expect(badge.element.tagName).toBe('SPAN')
  })

  it('supports keyboard selection without adding a nested button', async () => {
    const session = { id: 's1', title: 'Keyboard', updatedAt: new Date().toISOString() }
    const wrapper = mount(SessionItem, {
      props: { session, isActive: false },
    })

    await wrapper.find('[data-testid="session-item"]').trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('select')).toEqual([['s1']])
    expect(wrapper.find('[data-testid="session-pending-badge"]').exists()).toBe(false)
  })
})
