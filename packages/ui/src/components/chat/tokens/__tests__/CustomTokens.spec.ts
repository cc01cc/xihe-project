import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownTokens from '../MarkdownTokens.vue'
import { createMarkdownParser } from '@/services/markdownParser'

function mountTokens(content: string, streaming = false) {
  const parser = createMarkdownParser()
  const tokens = streaming ? parser.parseStreaming(content) : parser.parse(content)
  return mount(MarkdownTokens, {
    props: { tokens },
  })
}

describe('CustomTokens', () => {
  it('renders think content', () => {
    const wrapper = mountTokens('<think>hello</think>')
    expect(wrapper.text()).toContain('hello')
    expect(wrapper.find('details').exists()).toBe(true)
  })

  it('renders citation index', () => {
    const wrapper = mountTokens('text[1] more')
    expect(wrapper.text()).toContain('[1]')
  })

  it('renders artifact placeholder', () => {
    const wrapper = mountTokens('<artifact identifier="a1" type="html">hi</artifact>')
    expect(wrapper.text()).toContain('a1')
  })

  it('does not render math in streaming mode', () => {
    const wrapper = mountTokens('$x^2$', true)
    expect(wrapper.text()).toContain('$x^2$')
  })
})
