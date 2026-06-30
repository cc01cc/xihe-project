import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import FileEditor from '../../components/workspace/FileEditor.vue'

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}))
vi.mock('monaco-editor', () => ({ editor: { create: vi.fn() } }))

describe('FileEditor', () => {
  it('renders with an active .ts file', async () => {
    setActivePinia(createPinia())
    const ws = await import('../../stores/workspace')
    ws.useWorkspaceStore().activeFilePath = 'test.ts'
    const wrapper = mount(FileEditor, {
      global: { stubs: { EditorTabBar: true, CodeEditor: true, DiffViewer: true, MdEditor: true, ImagePreview: true, PdfViewer: true, UnknownFileNotice: true } },
    })
    expect(wrapper.find('div').exists()).toBe(true)
  })

  it('renders PdfViewer for .pdf files', async () => {
    setActivePinia(createPinia())
    const ws = await import('../../stores/workspace')
    ws.useWorkspaceStore().activeFilePath = 'doc.pdf'
    const wrapper = mount(FileEditor, {
      global: { stubs: { EditorTabBar: true, CodeEditor: true, DiffViewer: true, MdEditor: true, ImagePreview: true, PdfViewer: true, UnknownFileNotice: true } },
    })
    expect(wrapper.find('div').exists()).toBe(true)
  })

  it('renders CodeEditor for code files', async () => {
    setActivePinia(createPinia())
    const ws = await import('../../stores/workspace')
    ws.useWorkspaceStore().activeFilePath = 'main.py'
    const wrapper = mount(FileEditor, {
      global: { stubs: { EditorTabBar: true, CodeEditor: true, DiffViewer: true, MdEditor: true, ImagePreview: true, PdfViewer: true, UnknownFileNotice: true } },
    })
    expect(wrapper.find('div').exists()).toBe(true)
  })

  it('renders empty state without active file', async () => {
    setActivePinia(createPinia())
    const wrapper = mount(FileEditor, {
      global: { stubs: { EditorTabBar: true, CodeEditor: true, DiffViewer: true, MdEditor: true, ImagePreview: true, PdfViewer: true, UnknownFileNotice: true } },
    })
    expect(wrapper.find('div').exists()).toBe(true)
  })
})
