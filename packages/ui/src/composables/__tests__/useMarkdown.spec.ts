import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick } from 'vue'
import { useMarkdown } from '../useMarkdown'

describe('useMarkdown', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function mountUseMarkdown(initial = '', streaming = false) {
    const content = ref(initial)
    const isStreaming = ref(streaming)
    const TestComponent = defineComponent({
      setup() {
        const { tokens, mode } = useMarkdown(content, isStreaming, { throttleMs: 50 })
        return { tokens, mode, content, isStreaming }
      },
      template: '<div>{{ mode }}</div>',
    })
    const wrapper = mount(TestComponent)
    return { wrapper, content, isStreaming }
  }

  it('parses content in complete mode', async () => {
    const { wrapper } = mountUseMarkdown('# Hello')
    await flushPromises()
    expect(wrapper.vm.tokens[0].type).toBe('heading')
  })

  it('switches to streaming mode', async () => {
    const { wrapper, isStreaming } = mountUseMarkdown('# Hello', false)
    await flushPromises()
    expect(wrapper.vm.mode).toBe('complete')
    isStreaming.value = true
    await nextTick()
    expect(wrapper.vm.mode).toBe('streaming')
  })

  it('throttles streaming updates', async () => {
    const { content } = mountUseMarkdown('a', true)
    await flushPromises()
    content.value = 'ab'
    await nextTick()
    vi.advanceTimersByTime(10)
    content.value = 'abc'
    await nextTick()
    vi.advanceTimersByTime(100)
    await flushPromises()
  })

  it('appends placeholder for unclosed code fence in streaming mode', async () => {
    const { wrapper, content } = mountUseMarkdown('```js\nconst', true)
    await flushPromises()
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    content.value = '```js\nconst x'
    await nextTick()
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    const hasCode = wrapper.vm.tokens.some((t: { type: string }) => t.type === 'code')
    expect(hasCode).toBe(true)
  })
})
