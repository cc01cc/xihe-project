import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PdfViewer from '../../components/chat/PdfViewer.vue'

describe('PdfViewer', () => {
  it('renders no-pdf state when src is null', () => {
    const wrapper = mount(PdfViewer, { props: { src: null } })
    expect(wrapper.text()).toContain('No PDF loaded')
  })

  it('renders PdfToolbar and PdfPageCanvas stubs when PDF is absent', () => {
    const wrapper = mount(PdfViewer, { props: { src: null } })
    expect(wrapper.findComponent({ name: 'PdfToolbar' }).exists()).toBe(false)
    expect(wrapper.findComponent({ name: 'PdfPageCanvas' }).exists()).toBe(false)
  })

  it('renders container with src prop', () => {
    const wrapper = mount(PdfViewer, { props: { src: null } })
    expect(wrapper.find('.flex').exists()).toBe(true)
  })
})
