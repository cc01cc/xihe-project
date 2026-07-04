import { describe, expect, it } from 'vitest'
import {
  getContentBottom,
  getElementTop,
  getElementViewportTop,
  getFirstVisibleMessageItem,
  getLastScrollAnchor,
  getMaxScrollTop,
  getMessageScrollerItems,
  getMessageScrollerScrollable,
  getNewScrollAnchor,
  getTailSpacerHeight,
  getUnanchoredScrollAnchor,
  hasMultipleNewScrollAnchors,
} from '../messageScrollerGeometry'

function createElement(tag: string, options: Partial<HTMLElement> = {}): HTMLElement {
  const element = document.createElement(tag)

  for (const [key, value] of Object.entries(options)) {
    try {
      Object.defineProperty(element, key, {
        value,
        configurable: true,
        writable: true,
      })
    } catch {
      Object.assign(element, { [key]: value })
    }
  }

  return element
}

describe('getMessageScrollerScrollable', () => {
  it('returns false for both edges when content has no items', () => {
    const viewport = createElement('div', { clientHeight: 100, scrollHeight: 100, scrollTop: 0 })
    const content = createElement('div')

    expect(getMessageScrollerScrollable({ content, viewport, spacer: null, scrollEdgeThreshold: 8 })).toEqual({
      start: false,
      end: false,
    })
  })

  it('detects start edge when scrolled below threshold', () => {
    const viewport = createElement('div', { clientHeight: 100, scrollHeight: 300, scrollTop: 16 })
    const content = createElement('div')
    const item = createElement('div')
    item.dataset.messageId = '1'
    item.getBoundingClientRect = () => ({ top: -6, bottom: 94, height: 100, width: 100, left: 0, right: 100, x: 0, y: -6, toJSON: () => {} })
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, width: 100, left: 0, right: 100, x: 0, y: 0, toJSON: () => {} })
    content.append(item)

    expect(getMessageScrollerScrollable({ content, viewport, spacer: null, scrollEdgeThreshold: 8 }).start).toBe(true)
  })

  it('detects end edge when content extends below viewport bottom', () => {
    const viewport = createElement('div', { clientHeight: 100, scrollHeight: 300, scrollTop: 0 })
    const content = createElement('div')
    const item = createElement('div')
    item.dataset.messageId = '1'
    item.getBoundingClientRect = () => ({ top: 0, bottom: 120, height: 120, width: 100, left: 0, right: 100, x: 0, y: 0, toJSON: () => {} })
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, width: 100, left: 0, right: 100, x: 0, y: 0, toJSON: () => {} })
    content.append(item)

    expect(getMessageScrollerScrollable({ content, viewport, spacer: null, scrollEdgeThreshold: 8 }).end).toBe(true)
  })
})

describe('getMessageScrollerItems', () => {
  it('returns all HTMLElement children except spacer', () => {
    const content = createElement('div')
    const item1 = createElement('div')
    const item2 = createElement('div')
    const text = document.createTextNode('text')
    const spacer = createElement('div')
    spacer.dataset.slot = 'message-scroller-spacer'

    content.append(item1, item2, text, spacer)

    expect(getMessageScrollerItems(content, spacer)).toEqual([item1, item2])
  })
})

describe('getNewScrollAnchor', () => {
  it('returns the first new item after previous count', () => {
    const items = [createElement('div'), createElement('div'), createElement('div')]
    items[1].dataset.scrollAnchor = 'true'

    expect(getNewScrollAnchor(items, 1)).toBe(items[1])
  })

  it('returns null when no new items', () => {
    const items = [createElement('div')]

    expect(getNewScrollAnchor(items, 1)).toBeNull()
  })
})

describe('getUnanchoredScrollAnchor', () => {
  it('returns first item not in handled set', () => {
    const items = [createElement('div'), createElement('div')]
    items[0].dataset.scrollAnchor = 'true'
    items[1].dataset.scrollAnchor = 'true'
    const handled = new WeakSet<HTMLElement>()
    handled.add(items[0])

    expect(getUnanchoredScrollAnchor(items, handled)).toBe(items[1])
  })

  it('returns null when all items handled', () => {
    const items = [createElement('div')]
    items[0].dataset.scrollAnchor = 'true'
    const handled = new WeakSet<HTMLElement>()
    handled.add(items[0])

    expect(getUnanchoredScrollAnchor(items, handled)).toBeNull()
  })
})

describe('hasMultipleNewScrollAnchors', () => {
  it('returns true when more than one new item', () => {
    const items = [createElement('div'), createElement('div'), createElement('div')]
    items[1].dataset.scrollAnchor = 'true'
    items[2].dataset.scrollAnchor = 'true'

    expect(hasMultipleNewScrollAnchors(items, 1)).toBe(true)
  })

  it('returns false when only one new item', () => {
    const items = [createElement('div'), createElement('div')]
    items[1].dataset.scrollAnchor = 'true'

    expect(hasMultipleNewScrollAnchors(items, 1)).toBe(false)
  })
})

describe('getLastScrollAnchor', () => {
  it('returns last item when items exist', () => {
    const items = [createElement('div'), createElement('div')]
    items[1].dataset.scrollAnchor = 'true'

    expect(getLastScrollAnchor(items)).toBe(items[1])
  })

  it('returns null for empty array', () => {
    expect(getLastScrollAnchor([])).toBeNull()
  })
})

describe('getFirstVisibleMessageItem', () => {
  it('returns first item within viewport bounds', () => {
    const content = createElement('div')
    const viewport = createElement('div', { clientHeight: 100, scrollTop: 0 })
    const item = createElement('div')
    item.dataset.messageId = '1'
    item.getBoundingClientRect = () => ({ top: 10, bottom: 30, height: 20, width: 100, left: 0, right: 100, x: 0, y: 10, toJSON: () => {} })
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, width: 100, left: 0, right: 100, x: 0, y: 0, toJSON: () => {} })
    content.append(item)

    expect(getFirstVisibleMessageItem({ content, viewport, spacer: null })).toBe(item)
  })
})

describe('getElementTop', () => {
  it('computes offset top relative to viewport', () => {
    const element = createElement('div')
    const viewport = createElement('div')
    element.getBoundingClientRect = () => ({ top: 50, bottom: 70, height: 20, width: 100, left: 0, right: 100, x: 0, y: 50, toJSON: () => {} })
    viewport.getBoundingClientRect = () => ({ top: 10, bottom: 110, height: 100, width: 100, left: 0, right: 100, x: 0, y: 10, toJSON: () => {} })

    expect(getElementTop(element, viewport)).toBe(40)
  })
})

describe('getElementViewportTop', () => {
  it('returns element top offset relative to viewport top', () => {
    const element = createElement('div')
    const viewport = createElement('div')
    element.getBoundingClientRect = () => ({ top: 30, bottom: 50, height: 20, width: 100, left: 0, right: 100, x: 0, y: 30, toJSON: () => {} })
    viewport.getBoundingClientRect = () => ({ top: 10, bottom: 110, height: 100, width: 100, left: 0, right: 100, x: 0, y: 10, toJSON: () => {} })

    expect(getElementViewportTop(element, viewport)).toBe(20)
  })
})

describe('getTailSpacerHeight', () => {
  it('returns positive gap when content ends above viewport bottom', () => {
    const content = createElement('div')
    const viewport = createElement('div', { clientHeight: 100, scrollTop: 0 })
    const item = createElement('div')
    item.dataset.messageId = '1'
    item.getBoundingClientRect = () => ({ top: 0, bottom: 50, height: 50, width: 100, left: 0, right: 100, x: 0, y: 0, toJSON: () => {} })
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, width: 100, left: 0, right: 100, x: 0, y: 0, toJSON: () => {} })
    content.append(item)

    expect(getTailSpacerHeight({ content, viewport, spacer: null, scrollTop: 0 })).toBe(50)
  })
})

describe('getContentBottom', () => {
  it('computes content bottom from last item relative to viewport', () => {
    const content = createElement('div')
    const viewport = createElement('div')
    const item = createElement('div')
    item.dataset.messageId = '1'
    item.getBoundingClientRect = () => ({ top: 0, bottom: 80, height: 80, width: 100, left: 0, right: 100, x: 0, y: 0, toJSON: () => {} })
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 100, height: 100, width: 100, left: 0, right: 100, x: 0, y: 0, toJSON: () => {} })
    content.append(item)

    expect(getContentBottom({ content, viewport, spacer: null })).toBe(80)
  })
})

describe('getMaxScrollTop', () => {
  it('returns scroll height minus client height', () => {
    const viewport = createElement('div', { scrollHeight: 300, clientHeight: 100 })

    expect(getMaxScrollTop(viewport)).toBe(200)
  })
})
