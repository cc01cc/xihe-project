import { describe, it, expect } from 'vitest'
import { createMarkdownParser } from '../markdownParser'

describe('markdownParser', () => {
  const parser = createMarkdownParser()

  it('parses headings', () => {
    const tokens = parser.parse('# Hello\n\n## World')
    const headings = tokens.filter((t) => t.type === 'heading')
    expect(headings[0]).toMatchObject({ type: 'heading', depth: 1 })
    expect(headings[1]).toMatchObject({ type: 'heading', depth: 2 })
  })

  it('parses paragraphs', () => {
    const tokens = parser.parse('Hello world.')
    expect(tokens[0]).toMatchObject({ type: 'paragraph' })
  })

  it('parses nested lists', () => {
    const tokens = parser.parse('- a\n  - b\n  - c\n- d')
    expect(tokens[0].type).toBe('list')
    const list = tokens[0] as { items: { tokens: { type: string; items: unknown[] }[] }[] }
    expect(list.items).toHaveLength(2)
    expect(list.items[0].tokens.some((t) => t.type === 'list')).toBe(true)
  })

  it('parses task lists', () => {
    const tokens = parser.parse('- [x] done\n- [ ] todo')
    const list = tokens[0] as { items: { task: boolean; checked: boolean }[] }
    expect(list.items[0].task).toBe(true)
    expect(list.items[0].checked).toBe(true)
    expect(list.items[1].checked).toBe(false)
  })

  it('parses blockquotes', () => {
    const tokens = parser.parse('> quote')
    expect(tokens[0].type).toBe('blockquote')
  })

  it('parses GFM tables', () => {
    const tokens = parser.parse('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(tokens[0].type).toBe('table')
    const table = tokens[0] as { header: unknown[]; rows: unknown[] }
    expect(table.header).toHaveLength(2)
    expect(table.rows).toHaveLength(1)
  })

  it('parses code blocks', () => {
    const tokens = parser.parse('```js\nconst x = 1\n```')
    expect(tokens[0]).toMatchObject({ type: 'code', lang: 'js' })
  })

  it('parses inline math in complete mode', () => {
    const tokens = parser.parse('equation $x^2$ here')
    const paragraph = tokens[0] as { tokens: { type: string }[] }
    expect(paragraph.tokens.some((t) => t.type === 'inlineKatex')).toBe(true)
  })

  it('does not parse inline math in streaming mode', () => {
    const tokens = parser.parseStreaming('equation $x^2$ here')
    const paragraph = tokens[0] as { tokens: { type: string }[] }
    expect(paragraph.tokens.some((t) => t.type === 'inlineKatex')).toBe(false)
  })

  it('parses think tags', () => {
    const tokens = parser.parse('<think>hello</think>')
    expect(tokens[0]).toMatchObject({ type: 'think', text: 'hello', complete: true })
  })

  it('parses citations', () => {
    const tokens = parser.parse('text[1]')
    const paragraph = tokens[0] as { tokens: { type: string; index?: number }[] }
    expect(paragraph.tokens.some((t) => t.type === 'citation' && t.index === 1)).toBe(true)
  })

  it('parses artifacts', () => {
    const tokens = parser.parse('<artifact identifier="a1" type="text/html"><div>hi</div></artifact>')
    expect(tokens[0]).toMatchObject({ type: 'artifact', identifier: 'a1', artifactType: 'text/html' })
  })

  it('does not render raw HTML as trusted markup (html token is escaped by renderer layer)', () => {
    const tokens = parser.parse('<div>hello</div>')
    const htmlToken = tokens.find((t) => t.type === 'html')
    expect(htmlToken).toBeDefined()
    if (htmlToken) {
      expect((htmlToken as { block?: boolean }).block).toBe(true)
    }
  })
})
