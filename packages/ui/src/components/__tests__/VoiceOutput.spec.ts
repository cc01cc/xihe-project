import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import VoiceOutput from '../../components/multimodal/VoiceOutput.vue'

const messages = { 'zh-CN': { multimodal: { speak: '朗读' } } }
function createI18nInstance() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages })
}

beforeEach(() => {
  Object.defineProperty(window, 'speechSynthesis', {
    value: { cancel: vi.fn(), speak: vi.fn(), getVoices: vi.fn(() => []) },
    configurable: true,
    writable: true,
  })
  ;(globalThis as any).SpeechSynthesisUtterance = vi.fn((text: string) => ({
    onstart: null, onend: null, onerror: null, lang: '', rate: 1, text,
  }))
})

describe('VoiceOutput', () => {
  it('renders speak button', () => {
    const wrapper = mount(VoiceOutput, {
      props: { text: 'Hello' },
      global: { plugins: [createI18nInstance()] },
    })
    expect(wrapper.find('button').exists()).toBe(true)
  })

  it('calls speak on click when not speaking', async () => {
    const wrapper = mount(VoiceOutput, {
      props: { text: 'Hello' },
      global: { plugins: [createI18nInstance()] },
    })
    await wrapper.find('button').trigger('click')
    expect(window.speechSynthesis.speak).toHaveBeenCalled()
  })

  it('calls stop on click when already speaking', async () => {
    const cancelSpy = vi.spyOn(window.speechSynthesis, 'cancel')
    const wrapper = mount(VoiceOutput, {
      props: { text: 'Hello' },
      global: { plugins: [createI18nInstance()] },
    })
    wrapper.vm.isSpeaking = true
    await wrapper.vm.$nextTick()
    await wrapper.find('button').trigger('click')
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('does not render button when text is empty', () => {
    const wrapper = mount(VoiceOutput, {
      props: { text: '' },
      global: { plugins: [createI18nInstance()] },
    })
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
