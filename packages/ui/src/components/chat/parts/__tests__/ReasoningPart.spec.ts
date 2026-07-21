import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ReasoningPart from '../ReasoningPart.vue'

describe('ReasoningPart', () => {
  it('renders content in collapsed state', () => {
    const wrapper = mount(ReasoningPart, { props: { content: 'thinking text' } })
    expect(wrapper.text()).toContain('Reasoning')
    expect(wrapper.text()).toContain('thinking text')
  })

  it('renders empty content', () => {
    const wrapper = mount(ReasoningPart, { props: { content: '' } })
    expect(wrapper.find('details').exists()).toBe(true)
  })
})
