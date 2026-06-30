import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

describe('CodeBlock', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  it('renders code and language label', async () => {
    const { default: CodeBlock } = await import('../CodeBlock.vue')
    const wrapper = mount(CodeBlock, { props: { code: 'const x = 1', lang: 'typescript' } })
    expect(wrapper.text()).toContain('typescript')
    expect(wrapper.text()).toContain('const x = 1')
  })

  it('copy button changes text on click', async () => {
    const { default: CodeBlock } = await import('../CodeBlock.vue')
    const wrapper = mount(CodeBlock, { props: { code: 'test', lang: 'text' } })
    const btn = wrapper.findAll('button')[1]
    expect(btn.text()).toBe('chat.copy')
    await btn.trigger('click')
    expect(btn.text()).toBe('chat.copied')
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('test')
  })

  it('apply button dispatches custom event', async () => {
    const { default: CodeBlock } = await import('../CodeBlock.vue')
    const events: CustomEvent[] = []
    window.addEventListener('xihe:apply-code', (e) => events.push(e as CustomEvent))
    const wrapper = mount(CodeBlock, { props: { code: 'console.log(1)', lang: 'javascript' } })
    await wrapper.findAll('button')[0].trigger('click')
    expect(events).toHaveLength(1)
    expect(events[0].detail.code).toBe('console.log(1)')
    expect(events[0].detail.lang).toBe('javascript')
  })
})
