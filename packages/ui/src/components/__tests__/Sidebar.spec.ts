import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import Sidebar from '../sidebar/Sidebar.vue'
import { useSessionStore } from '../../stores/session'
import { useAuthStore } from '../../stores/auth'
import { useAgentStore } from '../../stores/agent'

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
      noWorkspace: '没有可用工作区',
      pendingApprovalBadge: '待审批',
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

function mockAuth(workspaceId = 'ws-test') {
  const auth = useAuthStore()
  auth.$patch({
    token: 'mock-token',
    user: { id: 'u-1', email: 'tester@xihe.local' },
    workspace: { id: workspaceId, name: 'Default Workspace' },
  })
  return auth
}

function stubSessionResponse(record: { id: string; title?: string; createdAt?: string }) {
  return {
    id: record.id,
    title: record.title ?? 'New Chat',
    workspaceId: 'ws-test',
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: record.createdAt ?? new Date().toISOString(),
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  pushSpy.mockClear()
  vi.restoreAllMocks()
})

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages,
})

async function mountSidebar() {
  const wrapper = mount(Sidebar, {
    props: { open: true, width: 280, isMobile: false },
    global: {
      plugins: [i18n],
      stubs: { Teleport: { template: '<div><slot /></div>' } },
    },
  })
  await flushPromises()
  return wrapper
}

describe('Sidebar', () => {
  it('renders new chat button with correct text', async () => {
    mockAuth()
    const wrapper = await mountSidebar()
    expect(wrapper.text()).toContain('新建对话')
  })

  it('clicking new chat calls server createSession and stores the result', async () => {
    mockAuth()
    const store = useSessionStore()
    expect(store.sessions.length).toBe(0)
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve(stubSessionResponse({ id: 'srv-1' })),
      } as Response)

    const wrapper = await mountSidebar()
    const buttons = wrapper.findAll('button')
    const newChatBtn = buttons.find((b) => b.text().trim() === '新建对话')
    expect(newChatBtn).toBeDefined()
    await newChatBtn!.trigger('click')
    await flushPromises()

    expect(spy).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(store.sessions.length).toBe(1)
    expect(store.sessions[0].id).toBe('srv-1')
    expect(store.sessions[0].title).toBe('New Chat')
    expect(pushSpy).toHaveBeenCalledWith('/workspace/ws-test/chat/srv-1')
  })

  it('clicking new chat shows toast when no current workspace is set', async () => {
    const auth = useAuthStore()
    auth.$patch({ token: 'mock', user: { id: 'u-1', email: 'x@xihe.local' } })
    const store = useSessionStore()
    const spy = vi.spyOn(globalThis, 'fetch')
    const wrapper = await mountSidebar()
    const buttons = wrapper.findAll('button')
    const newChatBtn = buttons.find((b) => b.text().trim() === '新建对话')
    await newChatBtn!.trigger('click')
    await flushPromises()

    // The click first tries to resolve the workspace (hydrate), then refuses;
    // a Session must never be created without workspace context.
    expect(spy).not.toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(store.sessions.length).toBe(0)
    expect(pushSpy).not.toHaveBeenCalled()
  })

  it('clicking new chat hydrates the workspace before creating a session', async () => {
    const auth = useAuthStore()
    auth.$patch({ token: 'mock', user: { id: 'u-1', email: 'x@xihe.local' } })
    const spy = vi.spyOn(globalThis, 'fetch')
    spy.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'ws-late', name: 'Late Workspace', ownerId: 'u-1' }),
    } as Response)
      .mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(stubSessionResponse({ id: 'late-1' })),
    } as Response)
    const store = useSessionStore()
    const wrapper = await mountSidebar()
    const buttons = wrapper.findAll('button')
    const newChatBtn = buttons.find((b) => b.text().trim() === '新建对话')
    await newChatBtn!.trigger('click')
    await flushPromises()

    expect(store.sessions.length).toBe(1)
    expect(store.sessions[0].id).toBe('late-1')
    expect(pushSpy).toHaveBeenCalledWith(expect.stringContaining('/chat/late-1'))
  })

  it('renders empty state when no sessions exist', async () => {
    mockAuth()
    const wrapper = await mountSidebar()
    expect(wrapper.text()).toContain('暂无对话')
  })

  it('renders session time group headers when sessions exist', async () => {
    mockAuth()
    const store = useSessionStore()
    const spy = vi.spyOn(globalThis, 'fetch')
    spy.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(stubSessionResponse({ id: 'hdr-1' })),
    } as Response)
    await store.createSession()
    spy.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(stubSessionResponse({ id: 'hdr-2' })),
    } as Response)
    await store.createSession()
    const wrapper = await mountSidebar()
    expect(wrapper.text()).toContain('今天')
  })

  it('renders settings and logout buttons', async () => {
    mockAuth()
    const wrapper = await mountSidebar()
    expect(wrapper.text()).toContain('设置')
    expect(wrapper.text()).toContain('退出登录')
  })

  it('shows the pending approval count on the matching session row', async () => {
    mockAuth()
    const sessions = useSessionStore()
    sessions.sessions.push({
      id: 'pending-session',
      title: 'Pending chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    const agent = useAgentStore()
    agent.pendingApprovalSummaries = [{
      sessionId: 'pending-session',
      workspaceId: 'ws-test',
      count: 3,
      oldestRequestedAt: new Date().toISOString(),
    }]

    const wrapper = await mountSidebar()

    expect(wrapper.find('[data-testid="session-pending-badge"]').text()).toContain('3')
    expect(wrapper.find('[data-testid="session-pending-badge"]').text()).toContain('待审批')
  })

  it('starts hidden when open is false', async () => {
    mockAuth()
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
