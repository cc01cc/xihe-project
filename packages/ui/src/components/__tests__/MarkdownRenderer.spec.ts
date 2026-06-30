import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarkdownRenderer from '../chat/MarkdownRenderer.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

describe('MarkdownRenderer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders complete markdown', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '# Hello\n\nworld', isStreaming: false },
    })
    await flushPromises()
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.find('p').exists()).toBe(true)
  })

  it('renders streaming markdown without math tokens', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '$x^2$', isStreaming: true },
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(wrapper.text()).toContain('$x^2$')
  })

  it('renders GFM table', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '| a | b |\n|---|---|\n| 1 | 2 |', isStreaming: false },
    })
    await flushPromises()
    expect(wrapper.find('table').exists()).toBe(true)
  })

  it('renders nested list', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '- a\n  - b\n- c', isStreaming: false },
    })
    await flushPromises()
    expect(wrapper.findAll('ul').length).toBeGreaterThanOrEqual(2)
  })
})
