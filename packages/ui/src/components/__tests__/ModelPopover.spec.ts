import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createRouter, createWebHistory } from 'vue-router'
import { nextTick } from 'vue'
import { useConfigStore } from '../../stores/config'
import { useSessionStore } from '../../stores/session'
import { useAuthStore } from '../../stores/auth'
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

function stubSessionResponse(record: { id: string; title?: string }) {
  return {
    id: record.id,
    title: record.title ?? 'New Chat',
    workspaceId: 'ws-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

async function createSessionInStore(id: string, title: string) {
  const auth = useAuthStore()
  auth.$patch({ token: 'mock', workspace: { id: 'ws-test', name: 'Default Workspace' } })
  const store = useSessionStore()
  vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 201,
    json: () => Promise.resolve(stubSessionResponse({ id, title })),
  } as Response)
  await store.createSession(title)
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
    vi.restoreAllMocks()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (url.includes('/messages') && method === 'GET') {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('/api/v1/sessions/') && method === 'PATCH') {
        return new Response(JSON.stringify({ id: 'mp-3', title: 'Updated' }), { status: 200 })
      }
      if (url.endsWith('/api/v1/sessions') && method === 'POST') {
        return new Response(JSON.stringify({ id: 'mp-3', title: 'New Chat' }), { status: 201 })
      }
      if (url.includes('/api/v1/models')) {
        return new Response(JSON.stringify({ models: {} }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    })
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
    await createSessionInStore('mp-1', 'Model chat')
    const configStore = useConfigStore()
    const sessionStore = useSessionStore()
    configStore.setSessionModel(sessionStore.currentSessionId!, 'deepseek', 'deepseek-chat')
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)

    const wrapper = mountPopover()
    expect(wrapper.text()).toContain('deepseek-chat')
    expect(wrapper.text()).toContain('DeepSeek')
    wrapper.unmount()
  })

  it('shows effective model from config defaults when no session binding', async () => {
    await createSessionInStore('mp-2', 'Default model')
    const configStore = useConfigStore()
    const sessionStore = useSessionStore()
    sessionStore.updateSession(sessionStore.currentSessionId!, { title: 'Default model' })
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
    await createSessionInStore('mp-3', 'Select me')
    const configStore = useConfigStore()
    const sessionStore = useSessionStore()
    configStore.modelCache = {
      models: { deepseek: ['deepseek-chat', 'deepseek-reasoner'] },
    }
    vi.spyOn(configStore, 'fetchModels').mockResolvedValue(undefined)
    const updateSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(stubSessionResponse({ id: 'mp-3' })),
      } as Response)

    const wrapper = mountPopover()
    await openContent(wrapper)
    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find((el) =>
      el.textContent?.includes('deepseek-chat'),
    )
    expect(option).toBeTruthy()
    ;(option as HTMLElement).click()
    for (let i = 0; i < 5; i += 1) {
      await flushPromises()
    }

    expect(updateSpy).toHaveBeenCalled()
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
    const settingsLink = Array.from(document.body.querySelectorAll('button')).find((el) =>
      el.textContent?.includes('Configure a Provider first'),
    )
    expect(settingsLink).toBeTruthy()
    settingsLink!.click()
    await flushPromises()
    expect(pushSpy).toHaveBeenCalledWith('/settings/config')
    wrapper.unmount()
  })
})
