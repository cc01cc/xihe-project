import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ChatPanel from '../ChatPanel.vue'
import ApprovalModal from '../ApprovalModal.vue'
import { i18n } from '../../../i18n'
import { api } from '../../../composables/api'
import { useAgentStore } from '../../../stores/agent'
import type { ApprovalRequest } from '../../../types'

vi.mock('../../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      decideChatApproval: vi.fn(),
      getPendingApprovals: vi.fn(),
    },
  }
})

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const STALE_REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const RUN_ID = '33333333-3333-4333-8333-333333333333'

const approval: ApprovalRequest = {
  requestId: REQUEST_ID,
  runId: RUN_ID,
  sessionId: SESSION_ID,
  tool: 'write_file',
  action: 'write file',
  details: '/test.txt',
  state: 'pending',
  policy: {
    effect: 'ask',
    sourceLayer: 'workspace',
    matchedRule: null,
    reason: 'No matching allow rule',
    mode: 'manual',
    actionClass: 'write',
    shape: 'structured',
  },
}

function mountPanel() {
  return mount(ChatPanel, {
    props: { sessionId: SESSION_ID },
    global: {
      plugins: [i18n],
      stubs: { SSEStream: true, InputArea: true, MessageList: true, SessionPolicyControls: true, ContextSourcesU1: true },
    },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(api.decideChatApproval).mockReset()
  vi.mocked(api.getPendingApprovals).mockReset()
  vi.mocked(api.getPendingApprovals).mockResolvedValue([])
})

describe('ChatPanel approval decision correlation (PLAN-0328 T1.14)', () => {
  it('ignores a decision whose requestId is not the actionable pending request', async () => {
    const decideChatApproval = vi.mocked(api.decideChatApproval)
    decideChatApproval.mockResolvedValue({
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
      decision: 'once',
    })
    const wrapper = mountPanel()
    useAgentStore().addApprovalRequest(approval)
    await nextTick()
    await flushPromises()

    const modal = wrapper.findComponent(ApprovalModal)
    expect(modal.exists()).toBe(true)
    modal.vm.$emit('approve', { decision: 'once', requestId: STALE_REQUEST_ID })
    await flushPromises()

    // A stale continuation can never approve a different (or no longer actionable) request.
    expect(decideChatApproval).not.toHaveBeenCalled()
    // The dropped event must not leave the panel busy: the real request still decides.
    await wrapper.find('[data-testid="approval-approve"]').trigger('click')
    await flushPromises()
    expect(decideChatApproval).toHaveBeenCalledTimes(1)
    expect(decideChatApproval).toHaveBeenCalledWith(REQUEST_ID, { decision: 'once' })
  })

  it('strips the requestId envelope before calling the decision API', async () => {
    const decideChatApproval = vi.mocked(api.decideChatApproval)
    decideChatApproval.mockResolvedValue({
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
      decision: 'session',
    })
    const wrapper = mountPanel()
    useAgentStore().addApprovalRequest(approval)
    await nextTick()
    await flushPromises()

    await wrapper.find('[data-testid="approval-allow-session"]').trigger('click')
    await flushPromises()

    expect(decideChatApproval).toHaveBeenCalledTimes(1)
    expect(decideChatApproval).toHaveBeenCalledWith(REQUEST_ID, { decision: 'session' })
  })
})

describe('ChatPanel approval dismiss and reopen pill (PLAN-0404)', () => {
  it('dismisses locally with zero decisions and reopens from the pill', async () => {
    const decideChatApproval = vi.mocked(api.decideChatApproval)
    decideChatApproval.mockResolvedValue({
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
      decision: 'once',
    })
    const wrapper = mountPanel()
    useAgentStore().addApprovalRequest(approval)
    await nextTick()
    await flushPromises()

    const modal = wrapper.findComponent(ApprovalModal)
    expect(modal.props('show')).toBe(true)

    modal.vm.$emit('dismiss')
    await nextTick()

    expect(decideChatApproval).not.toHaveBeenCalled()
    expect(modal.props('show')).toBe(false)
    const pill = wrapper.find('[data-testid="pending-approval-reopen-pill"]')
    expect(pill.exists()).toBe(true)
    expect(pill.attributes('type')).toBe('button')
    expect((pill.text() ?? '').trim().length).toBeGreaterThan(0)

    await pill.trigger('click')
    await nextTick()

    expect(modal.props('show')).toBe(true)
    expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(false)

    await wrapper.find('[data-testid="approval-approve"]').trigger('click')
    await flushPromises()

    expect(decideChatApproval).toHaveBeenCalledTimes(1)
    expect(decideChatApproval).toHaveBeenCalledWith(REQUEST_ID, { decision: 'once' })
  })

  it('keeps the dispatch_unknown recovery entry shown after a dismiss', async () => {
    const wrapper = mountPanel()
    useAgentStore().addApprovalRequest({ ...approval, state: 'dispatch_unknown' })
    await nextTick()
    await flushPromises()

    const modal = wrapper.findComponent(ApprovalModal)
    expect(modal.props('show')).toBe(true)

    modal.vm.$emit('dismiss')
    await nextTick()

    expect(modal.props('show')).toBe(true)
    expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(false)
    expect(vi.mocked(api.decideChatApproval)).not.toHaveBeenCalled()
  })

  it('drops the local dismiss record once the pending approval disappears', async () => {
    const wrapper = mountPanel()
    const store = useAgentStore()
    store.addApprovalRequest(approval)
    await nextTick()
    await flushPromises()

    const modal = wrapper.findComponent(ApprovalModal)
    modal.vm.$emit('dismiss')
    await nextTick()
    expect(modal.props('show')).toBe(false)
    expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(true)

    store.agentState.pendingApprovals.splice(0)
    await nextTick()
    expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(false)

    store.addApprovalRequest(approval)
    await nextTick()
    expect(modal.props('show')).toBe(true)
    expect(wrapper.find('[data-testid="pending-approval-reopen-pill"]').exists()).toBe(false)
  })

  it('ships reopen pill i18n keys in zh-CN and en-US without placeholders', () => {
    const keys = ['pendingApprovalReopenLabel', 'pendingApprovalReopenAction']
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const messages = i18n.global.getLocaleMessage(locale) as { chat: Record<string, string> }
      for (const key of keys) {
        expect(messages.chat[key], `${locale}.${key}`).toBeTruthy()
        expect(messages.chat[key], `${locale}.${key}`).not.toMatch(/\{[^}]*\}/)
      }
    }
  })
})
