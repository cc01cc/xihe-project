import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import Sidebar from '../sidebar/Sidebar.vue'
import { useSessionStore } from '../../stores/session'

const messages = {
  'zh-CN': {
    sidebar: {
      newChat: '新建对话',
      search: '搜索对话...',
      today: '今天',
      yesterday: '昨天',
      earlier: '更早',
      rename: '重命名',
      delete: '删除',
      empty: '暂无对话',
      settings: '设置',
      workspace: '工作区',
      logout: '退出登录',
    },
  },
}

const { pushSpy } = vi.hoisted(() => ({
  pushSpy: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushSpy }),
  useRoute: () => ({ params: {} }),
}))

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  pushSpy.mockClear()
})

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages,
})

describe('Sidebar', () => {
  it('renders new chat button with correct text', async () => {
    const wrapper = mount(Sidebar, {
      props: { open: true, width: 280, isMobile: false },
      global: {
        plugins: [i18n],
        stubs: { Teleport: { template: '<div><slot /></div>' } },
      },
    })

    expect(wrapper.text()).toContain('新建对话')
  })

  it('clicking new chat creates a session', async () => {
    const store = useSessionStore()
    expect(store.sessions.length).toBe(0)

    const wrapper = mount(Sidebar, {
      props: { open: true, width: 280, isMobile: false },
      global: {
        plugins: [i18n],
        stubs: { Teleport: { template: '<div><slot /></div>' } },
      },
    })

    const buttons = wrapper.findAll('button')
    const newChatBtn = buttons.find((b) => b.text().trim() === '新建对话')
    expect(newChatBtn).toBeDefined()
    await newChatBtn!.trigger('click')

    expect(store.sessions.length).toBe(1)
    expect(store.sessions[0].title).toBe('New Chat')
  })

  it('clicking new chat navigates to the new session', async () => {
    const wrapper = mount(Sidebar, {
      props: { open: true, width: 280, isMobile: false },
      global: {
        plugins: [i18n],
        stubs: { Teleport: { template: '<div><slot /></div>' } },
      },
    })

    const buttons = wrapper.findAll('button')
    const newChatBtn = buttons.find((b) => b.text().trim() === '新建对话')
    await newChatBtn!.trigger('click')

    expect(pushSpy).toHaveBeenCalledOnce()
    const callArg = pushSpy.mock.calls[0][0] as string
    expect(callArg).toMatch(/^\/chat\//)
  })

  it('renders empty state when no sessions exist', async () => {
    const wrapper = mount(Sidebar, {
      props: { open: true, width: 280, isMobile: false },
      global: {
        plugins: [i18n],
        stubs: { Teleport: { template: '<div><slot /></div>' } },
      },
    })

    expect(wrapper.text()).toContain('暂无对话')
  })

  it('renders session time group headers when sessions exist', async () => {
    const store = useSessionStore()
    store.createSession()
    store.createSession()

    const wrapper = mount(Sidebar, {
      props: { open: true, width: 280, isMobile: false },
      global: {
        plugins: [i18n],
        stubs: { Teleport: { template: '<div><slot /></div>' } },
      },
    })

    expect(wrapper.text()).toContain('今天')
  })

  it('renders settings button', async () => {
    const wrapper = mount(Sidebar, {
      props: { open: true, width: 280, isMobile: false },
      global: {
        plugins: [i18n],
        stubs: { Teleport: { template: '<div><slot /></div>' } },
      },
    })

    expect(wrapper.text()).toContain('设置')
  })

  it('renders search input', async () => {
    const wrapper = mount(Sidebar, {
      props: { open: true, width: 280, isMobile: false },
      global: {
        plugins: [i18n],
        stubs: { Teleport: { template: '<div><slot /></div>' } },
      },
    })

    const input = wrapper.find('input')
    expect(input.exists()).toBe(true)
    expect(input.attributes('placeholder')).toBe('搜索对话...')
  })

  it('search input filters sessions via store', async () => {
    const store = useSessionStore()
    const s1 = store.createSession()
    store.renameSession(s1.id, 'Alpha')
    const s2 = store.createSession()
    store.renameSession(s2.id, 'Beta')

    const wrapper = mount(Sidebar, {
      props: { open: true, width: 280, isMobile: false },
      global: {
        plugins: [i18n],
        stubs: { Teleport: { template: '<div><slot /></div>' } },
      },
    })

    const input = wrapper.find('input')
    await input.setValue('Alpha')

    expect(store.searchQuery).toBe('Alpha')
    expect(store.filteredSessions.length).toBe(1)
    expect(store.filteredSessions[0].title).toBe('Alpha')
  })

  it('starts hidden when open is false', async () => {
    const wrapper = mount(Sidebar, {
      props: { open: false, width: 280, isMobile: false },
      global: {
        plugins: [i18n],
        stubs: { Teleport: { template: '<div><slot /></div>' } },
      },
    })

    const aside = wrapper.find('aside')
    expect(aside.attributes('style')).toContain('width: 0px')
  })
})
