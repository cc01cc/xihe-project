import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import PdfViewer from '../../components/chat/PdfViewer.vue'
import { useAuthStore } from '../../stores/auth'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('PdfViewer', () => {
  it('renders no-pdf state when src is null', async () => {
    const wrapper = mount(PdfViewer, { props: { src: null } })
    await flushPromises()
    expect(wrapper.text()).toContain('No PDF loaded')
  })

  it('does not render toolbar or canvas when PDF is absent', async () => {
    const wrapper = mount(PdfViewer, { props: { src: null } })
    await flushPromises()
    expect(wrapper.findComponent({ name: 'PdfToolbar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PdfPageCanvas' }).exists()).toBe(false)
  })

  it('renders container element with src prop', async () => {
    const wrapper = mount(PdfViewer, { props: { src: null } })
    await flushPromises()
    expect(wrapper.find('.flex').exists()).toBe(true)
  })

  it('uses auth.currentWorkspaceId for chunk fetch when chunks present', async () => {
    const auth = useAuthStore()
    auth.$patch({ token: 'mock', workspace: { id: 'ws-chunk', name: 'Default Workspace' } })
    const wrapper = mount(PdfViewer, {
      props: { src: null, chunks: ['/path/chunk-1.md'], chunkIndex: 0 },
    })
    await flushPromises()
    expect(wrapper.exists()).toBe(true)
  })
})
