import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

describe('workspace store highlightFile', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('expands parent directories for a nested path', () => {
    const store = useWorkspaceStore()
    store.highlightFile('src/components/Button.tsx')
    expect(store.expandedPaths.has('src')).toBe(true)
    expect(store.expandedPaths.has('src/components')).toBe(true)
    expect(store.expandedPaths.has('src/components/Button.tsx')).toBe(true)
  })

  it('sets activeFilePath if file is already open', () => {
    const store = useWorkspaceStore()
    store.openFiles.set('test.txt', {
      path: 'test.txt',
      name: 'test.txt',
      content: '',
      originalContent: '',
      language: 'plaintext',
      modified: false,
      loading: false,
    })
    store.highlightFile('test.txt')
    expect(store.activeFilePath).toBe('test.txt')
  })

  it('handles single-segment paths', () => {
    const store = useWorkspaceStore()
    store.highlightFile('README.md')
    expect(store.expandedPaths.has('README.md')).toBe(true)
  })
})
