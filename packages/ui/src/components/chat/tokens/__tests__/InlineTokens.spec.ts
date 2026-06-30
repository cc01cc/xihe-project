import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InlineTokens from '../InlineTokens.vue'
import { createMarkdownParser, type MarkdownToken } from '@/services/markdownParser'

function findNestedToken(content: string, predicate: (t: MarkdownToken) => boolean): MarkdownToken | undefined {
  const parser = createMarkdownParser()
  const paragraph = parser.parse(content)[0] as { tokens: MarkdownToken[] }
  function search(tokens: MarkdownToken[]): MarkdownToken | undefined {
    for (const t of tokens) {
      if (predicate(t)) return t
      if ('tokens' in t && Array.isArray(t.tokens)) {
        const found = search(t.tokens as MarkdownToken[])
        if (found) return found
      }
    }
    return undefined
  }
  return search(paragraph.tokens)
}

function mountToken(token: MarkdownToken) {
  return mount(InlineTokens, { props: { token } })
}

describe('InlineTokens', () => {
  it('renders strong', () => {
    const token = findNestedToken('**bold**', (t) => t.type === 'strong')
    expect(token).toBeDefined()
    const wrapper = mountToken(token!)
    expect(wrapper.find('strong').text()).toBe('bold')
  })

  it('renders em', () => {
    const token = findNestedToken('*italic*', (t) => t.type === 'em')
    expect(token).toBeDefined()
    const wrapper = mountToken(token!)
    expect(wrapper.find('em').text()).toBe('italic')
  })

  it('renders codespan', () => {
    const token = findNestedToken('`code`', (t) => t.type === 'codespan')
    expect(token).toBeDefined()
    const wrapper = mountToken(token!)
    expect(wrapper.find('code').text()).toBe('code')
  })

  it('renders del', () => {
    const token = findNestedToken('~~del~~', (t) => t.type === 'del')
    expect(token).toBeDefined()
    const wrapper = mountToken(token!)
    expect(wrapper.find('del').text()).toBe('del')
  })

  it('renders link with security attributes', () => {
    const token = findNestedToken('[link](https://example.com)', (t) => t.type === 'link')
    expect(token).toBeDefined()
    const wrapper = mountToken(token!)
    const a = wrapper.find('a')
    expect(a.attributes('href')).toBe('https://example.com')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toBe('noopener noreferrer')
  })

  it('renders image', () => {
    const token = findNestedToken('![alt](https://example.com/a.png)', (t) => t.type === 'image')
    expect(token).toBeDefined()
    const wrapper = mountToken(token!)
    const img = wrapper.find('img')
    expect(img.attributes('src')).toBe('https://example.com/a.png')
    expect(img.attributes('alt')).toBe('alt')
  })

  it('renders citation', () => {
    const parser = createMarkdownParser()
    const paragraph = parser.parse('text[1]')[0] as { tokens: { type: string; index?: number }[] }
    const citationToken = paragraph.tokens.find((t) => t.type === 'citation')
    expect(citationToken).toBeDefined()
    expect(citationToken?.index).toBe(1)
  })
})
