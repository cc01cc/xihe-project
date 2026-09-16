import { describe, it, expect, beforeAll, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHistory } from 'vue-router'
import { useChatStore } from '../../stores/chat'
import { usePolicyStore } from '../../stores/policy'
import { api } from '../../composables/api'
import ChatView from '../chat/ChatView.vue'

const TEST_SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: { en: { chat: {
    placeholder: 'Type...', image: 'Image', voice: 'Voice', approvalModeLabel: 'Approval mode',
    approvalModeUnavailable: 'Not provided', approvalModeManual: 'Manual approval',
    approvalModeAuto: 'Auto allow',
    approvalAutoWarning: 'Auto warning', approvalAutoClose: 'Turn off auto',
    approvalModeChanged: 'Approval mode changed', approvalModeLoadFailed: 'Mode load failed',
    approvalModeChangeFailed: 'Mode change failed',
  }, multimodal: { captureScreen: 'Screenshot' } } },
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
    vi.restoreAllMocks()
  })

  it('shows thinking indicator when agent is thinking', async () => {
    await router.push(`/chat/${TEST_SESSION_ID}`)
    await router.isReady()
    useChatStore().setSessionRunState(TEST_SESSION_ID, 'thinking', 'run-thinking')
    const wrapper = mountChat()
    expect(wrapper.text()).toContain('Thinking')
  })

  it('shows executing indicator when agent is executing', async () => {
    await router.push(`/chat/${TEST_SESSION_ID}`)
    await router.isReady()
    useChatStore().setSessionRunState(TEST_SESSION_ID, 'executing', 'run-executing')
    const wrapper = mountChat()
    expect(wrapper.text()).toContain('Executing')
  })

  it('does not show indicator when agent is idle', async () => {
    await router.push(`/chat/${TEST_SESSION_ID}`)
    await router.isReady()
    useChatStore().setSessionRunState(TEST_SESSION_ID, 'idle')
    const wrapper = mountChat()
    expect(wrapper.text()).not.toContain('Thinking')
    expect(wrapper.text()).not.toContain('Executing')
  })

  it('renders message list container', async () => {
    await router.push(`/chat/${TEST_SESSION_ID}`)
    await router.isReady()
    const wrapper = mountChat()
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('renders InputArea at the bottom', async () => {
    await router.push(`/chat/${TEST_SESSION_ID}`)
    await router.isReady()
    const wrapper = mountChat()
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('shows the session mode and provides a one-click auto close', async () => {
    vi.spyOn(api, 'getPolicyMode').mockResolvedValue({ sessionId: TEST_SESSION_ID, mode: 'auto', sessionRules: 0 })
    const setMode = vi.spyOn(api, 'setPolicyMode').mockResolvedValue({ sessionId: TEST_SESSION_ID, mode: 'manual', scope: 'session' })
    await router.push(`/chat/${TEST_SESSION_ID}`)
    await router.isReady()
    const wrapper = mountChat()

    await flushPromises()
    await nextTick()
    await nextTick()
    expect(api.getPolicyMode).toHaveBeenCalledWith(TEST_SESSION_ID)
    expect(usePolicyStore().getState(TEST_SESSION_ID)?.mode).toBe('auto')
    expect(wrapper.find('[data-testid="session-policy-mode-badge"]').text()).toContain('Auto allow')
    expect(wrapper.find('[data-testid="session-policy-auto-banner"]').exists()).toBe(true)
    await wrapper.find('[data-testid="session-policy-auto-close"]').trigger('click')

    expect(setMode).toHaveBeenCalledWith(TEST_SESSION_ID, 'manual')
  })
})
