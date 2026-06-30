import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'

describe('MarkdownRenderer', () => {
  it('renders markdown content', async () => {
    const { default: MarkdownRenderer } = await import('../MarkdownRenderer.vue')
    const wrapper = mount(MarkdownRenderer, { props: { content: '# Hello\nworld' } })
    expect(wrapper.text()).toContain('Hello')
    expect(wrapper.text()).toContain('world')
  })

  it('renders empty content', async () => {
    const { default: MarkdownRenderer } = await import('../MarkdownRenderer.vue')
    const wrapper = mount(MarkdownRenderer, { props: { content: '' } })
    expect(wrapper.exists()).toBe(true)
  })
})
