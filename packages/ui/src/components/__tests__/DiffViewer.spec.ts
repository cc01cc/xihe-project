import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import DiffViewer from '../../components/workspace/DiffViewer.vue'

vi.mock('monaco-editor', () => ({ editor: { createDiffEditor: vi.fn(), createModel: vi.fn() } }), { spy: true })

describe('DiffViewer', () => {
  it('renders diff container div', () => {
    const wrapper = mount(DiffViewer, { props: { original: 'hello', modified: 'world' } })
    expect(wrapper.find('div').exists()).toBe(true)
  })

  it('accepts language prop', () => {
    const wrapper = mount(DiffViewer, { props: { original: 'a', modified: 'b', language: 'typescript' } })
    expect(wrapper.props('language')).toBe('typescript')
  })

  it('renders modified content in props', () => {
    const wrapper = mount(DiffViewer, { props: { original: 'hello', modified: 'world' } })
    expect(wrapper.props('original')).toBe('hello')
    expect(wrapper.props('modified')).toBe('world')
  })

  it('updates when original and modified change', async () => {
    const wrapper = mount(DiffViewer, { props: { original: 'a', modified: 'b' } })
    await wrapper.setProps({ original: 'new a', modified: 'new b' })
    expect(wrapper.props('original')).toBe('new a')
    expect(wrapper.props('modified')).toBe('new b')
  })
})
