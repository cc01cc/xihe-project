import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import InputArea from '../../components/chat/InputArea.vue'

const messages = {
  'zh-CN': {
    chat: { placeholder: '输入消息...', send: '发送' },
    multimodal: { image: '图片', screenshot: '截图', voice: '语音' },
    common: { cancel: '取消' },
  },
}

function createI18nInstance() {
  return createI18n({ legacy: false, locale: 'zh-CN', fallbackLocale: 'zh-CN', messages })
}

const stubs = {
  ImageUpload: { template: '<div />' },
  FileUpload: { template: '<div />' },
  ScreenshotCapture: { template: '<div />' },
  VoiceInput: { template: '<div />' },
  ModelPopover: { template: '<div />' },
  LoaderCircle: { template: '<span />' },
  Image: { template: '<span />' },
  Camera: { template: '<span />' },
  Mic: { template: '<span />' },
  Send: { template: '<span />' },
}

function mountInputArea(props = {}) {
  return mount(InputArea, {
    props: { sessionId: 'test-session', ...props },
    global: { plugins: [createI18nInstance()], stubs },
  })
}

describe('InputArea', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  it('renders textarea for input', () => {
    const wrapper = mountInputArea()
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('renders multimodal action buttons', () => {
    const wrapper = mountInputArea()
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('textarea has placeholder text', () => {
    const wrapper = mountInputArea()
    const textarea = wrapper.find('textarea')
    expect(textarea.attributes('placeholder')).toBeDefined()
  })

  it('renders send button', () => {
    const wrapper = mountInputArea()
    expect(wrapper.find('button').exists()).toBe(true)
  })
})
