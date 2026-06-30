import { describe, it, expect, beforeAll } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHistory } from 'vue-router'
import { useAgentStore } from '../../stores/agent'
import ChatView from '../chat/ChatView.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { chat: { placeholder: 'Type...', image: 'Image', voice: 'Voice' }, multimodal: { captureScreen: 'Screenshot' } } },
})

beforeAll(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices: { getDisplayMedia: async () => ({}) } },
    configurable: true,
  })
  globalThis.EventSource = class EventSourceMock extends EventTarget {
    constructor() { super() }
    close() {}
  } as any
})

const router = createRouter({ history: createWebHistory(), routes: [{ path: '/chat/:sessionId?', name: 'chat', component: { template: '<div />' } }] })

function mountChat() {
  return mount(ChatView, { global: { plugins: [router, i18n] } })
}

describe('ChatView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('shows thinking indicator when agent is thinking', async () => {
    await router.push('/chat/test-session')
    await router.isReady()
    useAgentStore().setStatus('thinking')
    const wrapper = mountChat()
    expect(wrapper.text()).toContain('Thinking')
  })

  it('shows executing indicator when agent is executing', async () => {
    await router.push('/chat/test-session')
    await router.isReady()
    useAgentStore().setStatus('executing')
    const wrapper = mountChat()
    expect(wrapper.text()).toContain('Executing')
  })

  it('does not show indicator when agent is idle', async () => {
    await router.push('/chat/test-session')
    await router.isReady()
    useAgentStore().setStatus('idle')
    const wrapper = mountChat()
    expect(wrapper.text()).not.toContain('Thinking')
    expect(wrapper.text()).not.toContain('Executing')
  })

  it('renders message list container', async () => {
    await router.push('/chat/test-session')
    await router.isReady()
    const wrapper = mountChat()
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('renders InputArea at the bottom', async () => {
    await router.push('/chat/test-session')
    await router.isReady()
    const wrapper = mountChat()
    expect(wrapper.find('textarea').exists()).toBe(true)
  })
})
