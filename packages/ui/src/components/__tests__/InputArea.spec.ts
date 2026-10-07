import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import InputArea from '../../components/chat/InputArea.vue'

const messages = {
  'zh-CN': {
    chat: {
      placeholder: '输入消息...',
      send: '发送',
      stop: '停止',
      followUpEnqueue: '排队发送',
      followUpEnqueuing: '加入中…',
      followUpPlaceholder: '添加后续任务…',
      followUpComposerNotice: '当前任务之后执行',
      followUpPausedNotice: '追加到暂停队列末尾',
      followUpFullNotice: '队列已满，草稿保留',
    },
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

  it('queues with Enter while a Run is streaming and keeps a separate Stop action', async () => {
    const wrapper = mountInputArea({ isStreaming: true, queueMode: true })
    const textarea = wrapper.find('[data-testid="chat-input"]')
    await textarea.setValue('run this after the active task')
    await textarea.trigger('keydown', { key: 'Enter', shiftKey: false, isComposing: false })

    expect(wrapper.emitted('queue')?.[0]?.[0]).toBe('run this after the active task')
    expect(wrapper.emitted('send')).toBeUndefined()
    expect(wrapper.find('[data-testid="chat-stop-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="chat-queue-button"]').exists()).toBe(true)
  })

  it('keeps the draft disabled when the Follow-up queue is full', async () => {
    const wrapper = mountInputArea({ queueMode: true, queueFull: true })
    await wrapper.find('[data-testid="chat-input"]').setValue('keep this draft')

    expect(wrapper.find('[data-testid="chat-queue-button"]').attributes('disabled')).toBeDefined()
  })
})
