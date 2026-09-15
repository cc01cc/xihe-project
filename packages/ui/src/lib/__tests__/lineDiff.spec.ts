import { describe, it, expect } from 'vitest'
import { computeLineDiff } from '../lineDiff'

describe('computeLineDiff', () => {
  it('returns context rows for identical content', () => {
    const diff = computeLineDiff('a\nb\n', 'a\nb\n')
    expect(diff.rows).toEqual([
      { type: 'context', text: 'a' },
      { type: 'context', text: 'b' },
      { type: 'context', text: '' },
    ])
    expect(diff.truncated).toBe(false)
  })

  it('aligns replaced lines as one removal and one addition', () => {
    const diff = computeLineDiff('keep\nold\n', 'keep\nnew\n')
    expect(diff.rows).toEqual([
      { type: 'context', text: 'keep' },
      { type: 'remove', text: 'old' },
      { type: 'add', text: 'new' },
      { type: 'context', text: '' },
    ])
  })

  it('marks pure additions and removals', () => {
    expect(computeLineDiff('', 'added\n').rows).toEqual([
      { type: 'add', text: 'added' },
      { type: 'context', text: '' },
    ])
    expect(computeLineDiff('gone\n', '').rows).toEqual([
      { type: 'remove', text: 'gone' },
      { type: 'context', text: '' },
    ])
  })

  it('cuts both sides at maxLines and reports truncation', () => {
    const oldText = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n')
    const newText = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n')
    const diff = computeLineDiff(oldText, newText, 3)
    expect(diff.truncated).toBe(true)
    expect(diff.rows.filter((row) => row.type === 'context')).toHaveLength(3)
  })
})
