import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'

const messages = { 'zh-CN': { multimodal: { voice: '语音' } } }
function createI18nInstance() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages })
}

describe('VoiceInput', () => {
  beforeEach(() => {
    ;(globalThis as any).SpeechRecognition = vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      lang: '',
      continuous: false,
      interimResults: false,
      onresult: null,
      onend: null,
      onerror: null,
    }))
  })

  it('renders voice input button', async () => {
    const { default: VoiceInput } = await import('../../components/multimodal/VoiceInput.vue')
    const wrapper = mount(VoiceInput, { global: { plugins: [createI18nInstance()] } })
    expect(wrapper.find('button').exists()).toBe(true)
  })
})
