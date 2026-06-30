import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ImageUpload from '../../components/multimodal/ImageUpload.vue'

const messages = { 'zh-CN': { multimodal: { dragHint: '拖放图片到此处', uploadImage: '上传图片' } } }
function createI18nInstance() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages })
}

describe('ImageUpload', () => {
  it('renders drop zone', async () => {
    const wrapper = mount(ImageUpload, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.find('div').exists()).toBe(true)
  })

  it('renders file input', async () => {
    const wrapper = mount(ImageUpload, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.find('input[type="file"]').exists()).toBe(true)
  })

  it('accepts image files only', async () => {
    const wrapper = mount(ImageUpload, { global: { plugins: [createI18nInstance()] } })
    const input = wrapper.find('input[type="file"]')
    expect(input.attributes('accept')).toContain('image/')
  })

  it('emits upload event on file selection', async () => {
    // Mock Image to resolve immediately (jsdom doesn't support real image loading)
    const OriginalImage = globalThis.Image
    globalThis.Image = class extends OriginalImage {
      constructor() {
        super()
        setTimeout(() => {
          if (this.onload) this.onload(new Event('load'))
        }, 0)
      }
    } as typeof Image

    const wrapper = mount(ImageUpload, { global: { plugins: [createI18nInstance()] } })
    const input = wrapper.find('input[type="file"]')
    const file = new File(['test'], 'test.png', { type: 'image/png' })
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')

    // Wait for async handleFiles → maxDimension → emit
    await vi.waitFor(() => {
      expect(wrapper.emitted('upload')).toBeDefined()
    })

    globalThis.Image = OriginalImage
  })
})
