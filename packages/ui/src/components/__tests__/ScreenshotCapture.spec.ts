import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import ScreenshotCapture from '../../components/multimodal/ScreenshotCapture.vue'

const messages = { 'zh-CN': { multimodal: { captureScreen: '截图' } } }
function createI18nInstance() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages })
}

describe('ScreenshotCapture', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getDisplayMedia: vi.fn() },
      configurable: true, writable: true,
    })
  })

  it('renders capture button', () => {
    const wrapper = mount(ScreenshotCapture, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.find('button').exists()).toBe(true)
  })
})
