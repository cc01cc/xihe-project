import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownTokens from '../MarkdownTokens.vue'
import { createMarkdownParser } from '@/services/markdownParser'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

function mountTokens(content: string) {
  const parser = createMarkdownParser()
  return mount(MarkdownTokens, {
    props: { tokens: parser.parse(content) },
  })
}

describe('MarkdownTokens', () => {
  it('renders headings', () => {
    const wrapper = mountTokens('# Title')
    expect(wrapper.find('h1').exists()).toBe(true)
    expect(wrapper.find('h1').text()).toContain('Title')
  })

  it('renders paragraphs', () => {
    const wrapper = mountTokens('Hello world')
    expect(wrapper.find('p').exists()).toBe(true)
  })

  it('renders nested lists', () => {
    const wrapper = mountTokens('- a\n  - b')
    expect(wrapper.find('ul').exists()).toBe(true)
    expect(wrapper.findAll('ul').length).toBeGreaterThanOrEqual(2)
  })

  it('renders task lists', () => {
    const wrapper = mountTokens('- [x] done')
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true)
  })

  it('renders blockquotes', () => {
    const wrapper = mountTokens('> quote')
    expect(wrapper.find('blockquote').exists()).toBe(true)
  })

  it('renders tables', () => {
    const wrapper = mountTokens('| a |\n|---|\n| 1 |')
    expect(wrapper.find('table').exists()).toBe(true)
  })

  it('renders inline formatting', () => {
    const wrapper = mountTokens('**bold** and *italic*')
    expect(wrapper.find('strong').exists()).toBe(true)
    expect(wrapper.find('em').exists()).toBe(true)
  })

  it('renders code blocks via CodeBlock shell', () => {
    const wrapper = mountTokens('```js\nconst x = 1\n```')
    expect(wrapper.findComponent({ name: 'CodeBlock' }).exists()).toBe(true)
  })
})
