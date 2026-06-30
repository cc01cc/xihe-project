import { describe, it, expect, beforeEach, vi, beforeAll, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHistory } from 'vue-router'
import { nextTick } from 'vue'
import { useConfigStore } from '../../stores/config'
import { useSessionStore } from '../../stores/session'
import ModelPopover from '../chat/ModelPopover.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      chat: {
        modelSelectorPlaceholder: 'Select Model',
        noProvidersConfigured: 'Configure a Provider first',
        providersNoModels: 'No models available',
        searchModels: 'Search models...',
        noSearchResults: 'No matching models',
        favorites: 'Favorites',
        modelFetchFailed: 'Failed to fetch models',
        stop: 'Stop',
      },
      sidebar: {
        newChat: 'New Chat',
        search: 'Search...',
        today: 'Today',
        yesterday: 'Yesterday',
        earlier: 'Earlier',
        rename: 'Rename',
        delete: 'Delete',
        empty: 'No sessions',
        settings: 'Settings',
        logout: 'Logout',
        workspace: 'Workspace',
      },
    },
  },
})

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/chat/:sessionId?', name: 'chat', component: { template: '<div />' } },
    { path: '/settings/config', name: 'settings-config', component: { template: '<div />' } },
  ],
})

const { pushSpy } = vi.hoisted(() => ({
  pushSpy: vi.fn(),
}))

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    useRouter: () => ({ push: pushSpy }),
  }
})

function mountPopover() {
  return mount(ModelPopover, {
    attachTo: document.body,
    global: {
      plugins: [i18n, router],
    },
  })
}

async function openContent(wrapper: ReturnType<typeof mountPopover>) {
  const trigger = wrapper.find('button')
  await trigger.trigger('click')
  await flushPromises()
  await nextTick()
}

describe('ModelPopover', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getDisplayMedia: async () => ({}) } },
      configurable: true,
    })
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  beforeEach(async () => {
    setActivePinia(createPinia())
    localStorage.clear()
    pushSpy.mockClear()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }))
    document.body.innerHTML = ''
    await router.push('/chat')
    await router.isReady()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows placeholder when no model selected', async () => {
    const wrapper = mountPopover()
    expect(wrapper.text()).toContain('Select Model')
    wrapper.unmount()
  })

  it('shows selected model name in trigger', async () => {
    const configStore = useConfigStore()
    const sessionStore = useSessionStore()
    sessionStore.createSession()
    configStore.setSessionModel(sessionStore.currentSessionId!, 'deepseek', 'deepseek-chat')
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    expect(wrapper.text()).toContain('deepseek-chat')
    expect(wrapper.text()).toContain('DeepSeek')
    wrapper.unmount()
  })

  it('shows effective model from config defaults when no session binding', async () => {
    const configStore = useConfigStore()
    const sessionStore = useSessionStore()
    sessionStore.createSession()
    configStore.$patch({
      mergedConfig: {
        'llm-provider': { defaultProvider: 'openai' },
        'user-preference': { defaultModel: 'gpt-4o' },
      },
    })
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    expect(wrapper.text()).toContain('gpt-4o')
    expect(wrapper.text()).toContain('OpenAI')
    wrapper.unmount()
  })

  it('shows "Configure a Provider" link when no providers', async () => {
    const configStore = useConfigStore()
    configStore.modelCache = { models: {} }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    await openContent(wrapper)
    expect(document.body.textContent).toContain('Configure a Provider first')
    wrapper.unmount()
  })

  it('shows "No models available" when providers exist but all empty', async () => {
    const configStore = useConfigStore()
    configStore.modelCache = { models: { deepseek: [], openai: [] } }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    await openContent(wrapper)
    expect(document.body.textContent).toContain('No models available')
    wrapper.unmount()
  })

  it('renders provider group headers', async () => {
    const configStore = useConfigStore()
    configStore.modelCache = {
      models: { deepseek: ['deepseek-chat', 'deepseek-reasoner'], openai: ['gpt-4o'] },
    }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    await openContent(wrapper)
    expect(document.body.textContent).toContain('DeepSeek')
    expect(document.body.textContent).toContain('OpenAI')
    wrapper.unmount()
  })

  it('renders model IDs with provider names', async () => {
    const configStore = useConfigStore()
    configStore.modelCache = {
      models: { deepseek: ['deepseek-chat'] },
    }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    await openContent(wrapper)
    expect(document.body.textContent).toContain('deepseek-chat')
    expect(document.body.textContent).toContain('DeepSeek')
    wrapper.unmount()
  })

  it('selects model and updates session', async () => {
    const configStore = useConfigStore()
    const sessionStore = useSessionStore()
    sessionStore.createSession()
    configStore.modelCache = {
      models: { deepseek: ['deepseek-chat', 'deepseek-reasoner'] },
    }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    await openContent(wrapper)
    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes('deepseek-chat'),
    )
    expect(option).toBeTruthy()
    ;(option as HTMLElement).click()
    await flushPromises()

    const binding = configStore.getActiveModel(sessionStore.currentSessionId!)
    expect(binding).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    wrapper.unmount()
  })

  it('toggles favorite when star clicked', async () => {
    const configStore = useConfigStore()
    configStore.modelCache = {
      models: { deepseek: ['deepseek-chat'] },
    }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    await openContent(wrapper)
    expect(configStore.isFavorite('deepseek', 'deepseek-chat')).toBe(false)

    const starBtn = Array.from(document.body.querySelectorAll('button')).find((el) =>
      el.getAttribute('aria-label')?.includes('Favorite'),
    )
    expect(starBtn).toBeTruthy()
    starBtn!.click()
    await flushPromises()

    expect(configStore.isFavorite('deepseek', 'deepseek-chat')).toBe(true)
    wrapper.unmount()
  })

  it('filters models by search', async () => {
    const configStore = useConfigStore()
    configStore.modelCache = {
      models: { deepseek: ['deepseek-chat', 'deepseek-reasoner'], openai: ['gpt-4o'] },
    }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    await openContent(wrapper)
    const input = document.body.querySelector('input')
    expect(input).toBeTruthy()
    ;(input as HTMLInputElement).value = 'reasoner'
    input!.dispatchEvent(new Event('input'))
    await flushPromises()
    await nextTick()

    expect(document.body.textContent).toContain('deepseek-reasoner')
    expect(document.body.textContent).not.toContain('gpt-4o')
    wrapper.unmount()
  })

  it('navigates to settings when "Configure a Provider" clicked', async () => {
    const configStore = useConfigStore()
    configStore.modelCache = { models: {} }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    await openContent(wrapper)
    const link = Array.from(document.body.querySelectorAll('button')).find((el) =>
      el.textContent?.includes('Configure a Provider first'),
    )
    expect(link).toBeTruthy()
    link!.click()
    await flushPromises()

    expect(pushSpy).toHaveBeenCalledWith('/settings/config')
    wrapper.unmount()
  })

  it('shows "No matching models" when search has no results', async () => {
    const configStore = useConfigStore()
    configStore.modelCache = {
      models: { deepseek: ['deepseek-chat'] },
    }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    await openContent(wrapper)
    const input = document.body.querySelector('input')
    expect(input).toBeTruthy()
    ;(input as HTMLInputElement).value = 'nonexistent-xyz'
    input!.dispatchEvent(new Event('input'))
    await flushPromises()
    await nextTick()

    expect(document.body.textContent).toContain('No matching models')
    wrapper.unmount()
  })
})
