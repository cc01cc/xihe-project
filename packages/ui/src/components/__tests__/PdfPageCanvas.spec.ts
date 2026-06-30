import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import PdfPageCanvas from '../../components/chat/PdfPageCanvas.vue'

vi.mock('pdfjs-dist', () => ({
  default: {
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: vi.fn(() => ({
      promise: Promise.resolve({
        numPages: 5,
        getPage: vi.fn(() => Promise.resolve({
          getViewport: vi.fn(({ scale }: any) => ({
            width: Math.round(612 * scale),
            height: Math.round(792 * scale),
          })),
          render: vi.fn(({ canvasContext, viewport }: any) => ({
            promise: Promise.resolve(),
            cancel: vi.fn(),
          })),
        })),
      }),
    })),
  },
}))

describe('PdfPageCanvas', () => {
  it('renders container div', () => {
    const wrapper = mount(PdfPageCanvas, {
      props: { pdfDoc: null, pageNum: 1, scale: 1.0 },
    })
    expect(wrapper.find('div').exists()).toBe(true)
  })

  it('accepts pageNum and scale props', () => {
    const wrapper = mount(PdfPageCanvas, {
      props: { pdfDoc: null, pageNum: 3, scale: 1.5 },
    })
    expect(wrapper.props('pageNum')).toBe(3)
    expect(wrapper.props('scale')).toBe(1.5)
  })
})
