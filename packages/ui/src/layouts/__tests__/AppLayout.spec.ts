import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createI18n } from 'vue-i18n'
import { createPinia, setActivePinia } from 'pinia'
import { api } from '../../composables/api'
import { useAuthStore } from '../../stores/auth'
import { useSessionStore } from '../../stores/session'
import AppLayout from '../AppLayout.vue'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      getPendingApprovals: vi.fn(),
      decideChatApproval: vi.fn(),
    },
  }
})

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      sidebar: {
        pendingApprovalBadge: 'Pending approval',
        pendingApprovalBanner: 'A session is waiting for approval',
        pendingApprovalCount: 'items pending',
        pendingApprovalGoTo: 'Review now',
        pendingApprovalLive: 'Pending approval count updated',
      },
    },
  },
})

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/chat/:sessionId?', component: { template: '<div data-testid="route-view" />' } },
      { path: '/workspace/:workspaceId', component: { template: '<div data-testid="route-view" />' } },
    ],
  })
}

async function mountLayout(router: ReturnType<typeof createTestRouter>, path = '/chat/current') {
  await router.push(path)
  await router.isReady()
  const wrapper = mount(AppLayout, {
    global: {
      plugins: [router, i18n],
      stubs: {
        Sidebar: { template: '<aside data-testid="sidebar-stub" />' },
        'router-view': { template: '<div data-testid="route-view" />' },
      },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.getPendingApprovals).mockResolvedValue([])
  const auth = useAuthStore()
  auth.$patch({
    token: 'token',
    user: { id: 'user-1', email: 'test@xihe.local' },
    workspace: { id: 'workspace-1', name: 'Workspace' },
  })
})

describe('AppLayout pending approval indicators', () => {
  it('renders the global banner for another session and navigates without deciding', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([{
      sessionId: 'other-session',
      workspaceId: 'workspace-1',
      count: 2,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])
    const router = createTestRouter()
    const wrapper = await mountLayout(router)

    expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="global-pending-approval-banner"]').text()).toContain('2')
    expect(wrapper.find('[data-testid="pending-approval-live"]').attributes('aria-live')).toBe('polite')

    await wrapper.find('[data-testid="global-pending-approval-go-to"]').trigger('click')
    await flushPromises()

    expect(router.currentRoute.value.fullPath).toBe('/chat/other-session')
    expect(api.decideChatApproval).not.toHaveBeenCalled()
  })

  it('does not render a global banner for the current session', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([{
      sessionId: 'current',
      workspaceId: 'workspace-1',
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])
    const wrapper = await mountLayout(createTestRouter())

    expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pending-approval-live"]').text()).toContain('1')
  })

  it('uses the session store current session for /chat/default', async () => {
    useSessionStore().selectSession('current')
    vi.mocked(api.getPendingApprovals).mockResolvedValue([{
      sessionId: 'current',
      workspaceId: 'workspace-1',
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])
    const wrapper = await mountLayout(createTestRouter(), '/chat/default')

    expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(false)
  })

  it('uses the session store current session for workspace routes', async () => {
    useSessionStore().selectSession('current')
    vi.mocked(api.getPendingApprovals).mockResolvedValue([{
      sessionId: 'current',
      workspaceId: 'workspace-1',
      count: 1,
      oldestRequestedAt: '2026-09-14T12:00:00Z',
    }])
    const wrapper = await mountLayout(createTestRouter(), '/workspace/workspace-1')

    expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(false)
  })

  it('does not render a banner for zero-count summaries', async () => {
    vi.mocked(api.getPendingApprovals).mockResolvedValue([{
      sessionId: 'other-session',
      workspaceId: 'workspace-1',
      count: 0,
      oldestRequestedAt: '',
    }])
    const wrapper = await mountLayout(createTestRouter())

    expect(wrapper.find('[data-testid="global-pending-approval-banner"]').exists()).toBe(false)
  })

  it('refreshes once on mount and once per conservative poll interval', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = await mountLayout(createTestRouter())
      expect(api.getPendingApprovals).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(10_000)
      await flushPromises()
      expect(api.getPendingApprovals).toHaveBeenCalledTimes(2)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
