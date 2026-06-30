import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import CodeBlockToken from '../CodeBlockToken.vue'
import CodeBlock from '../../CodeBlock.vue'
import { markdownContextKey } from '../markdownContext'
import type HljsApi from 'highlight.js'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock('highlight.js', async () => {
  const actual = await vi.importActual<typeof HljsApi>('highlight.js')
  return {
    default: {
      ...actual.default,
      highlight: vi.fn().mockReturnValue({ value: '<span>highlighted</span>' }),
      highlightAuto: vi.fn().mockReturnValue({ value: '<span>auto</span>' }),
      getLanguage: vi.fn((lang: string) => lang === 'js'),
    },
  }
})

describe('CodeBlockToken', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders CodeBlock shell with raw code and lang', () => {
    const wrapper = mount(CodeBlockToken, {
      props: { token: { type: 'code', raw: '```js\nx\n```', lang: 'js', text: 'x' } },
      global: {
        provide: {
          [markdownContextKey]: { isStreaming: true },
        },
      },
    })
    const shell = wrapper.findComponent(CodeBlock)
    expect(shell.exists()).toBe(true)
    expect(shell.props('code')).toBe('x')
    expect(shell.props('lang')).toBe('js')
  })
})
