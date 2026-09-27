import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import ChatPanel from '../ChatPanel.vue'
import ApprovalModal from '../ApprovalModal.vue'
import SessionDerivedStatePanel from '../SessionDerivedStatePanel.vue'
import SSEStream from '../SSEStream.vue'
import MessageList from '../MessageList.vue'
import { i18n } from '../../../i18n'
import { api } from '../../../composables/api'
import { useAgentStore } from '../../../stores/agent'
import { useChatStore } from '../../../stores/chat'
import type { ApprovalRequest, SessionDerivedStateResponse } from '../../../types'

vi.mock('../../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      decideChatApproval: vi.fn(),
      getPendingApprovals: vi.fn(),
      getMessages: vi.fn(),
      getSessionDerivedState: vi.fn(),
      listOperations: vi.fn(),
      getOperationTrace: vi.fn(),
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
  vi.mocked(api.getMessages).mockReset()
  vi.mocked(api.getMessages).mockResolvedValue([])
  vi.mocked(api.getSessionDerivedState).mockReset()
  vi.mocked(api.getSessionDerivedState).mockResolvedValue({
    sessionId: SESSION_ID,
    activeChildren: [],
    terminalNotices: [],
  })
  vi.mocked(api.listOperations).mockReset()
  vi.mocked(api.listOperations).mockResolvedValue({
    operations: [],
    page: 0,
    size: 50,
    totalElements: 0,
    totalPages: 0,
  })
  vi.mocked(api.getOperationTrace).mockReset()
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

describe('ChatPanel derived child state (PLAN-0408 M3)', () => {
  const derivedState: SessionDerivedStateResponse = {
    sessionId: SESSION_ID,
    activeChildren: [{
      childSessionId: '44444444-4444-4444-8444-444444444444',
      runId: '55555555-5555-4555-8555-555555555555',
      name: 'Research child',
      status: 'running',
    }],
    terminalNotices: [],
  }

  it('loads the API projection for the current Session and renders it separately from messages', async () => {
    vi.mocked(api.getSessionDerivedState).mockResolvedValue(derivedState)
    const wrapper = mountPanel()
    await flushPromises()

    expect(api.getSessionDerivedState).toHaveBeenCalledWith(SESSION_ID)
    const panel = wrapper.findComponent(SessionDerivedStatePanel)
    expect(panel.exists()).toBe(true)
    expect(panel.props('activeChildren')).toEqual(derivedState.activeChildren)
    expect(panel.props('terminalNotices')).toEqual([])
  })

  it('treats the SSE event as a refresh hint and associates tool waiting by durable childRunId', async () => {
    const response = vi.mocked(api.getSessionDerivedState)
    response.mockResolvedValue(derivedState)
    const wrapper = mountPanel()
    await flushPromises()

    const chatStore = useChatStore()
    chatStore.addMessage(SESSION_ID, {
      id: 'parent-user-message',
      sessionId: SESSION_ID,
      role: 'user',
      content: 'run spawn_agent',
      timestamp: '2026-09-27T00:00:00Z',
      runId: RUN_ID,
    })
    chatStore.addMessage(SESSION_ID, {
      id: 'message-tool-call',
      sessionId: SESSION_ID,
      role: 'assistant',
      content: '',
      timestamp: '2026-09-27T00:00:00Z',
      toolCalls: [{ id: 'spawn-tool-call', runId: 'agent-tool-run', name: 'spawn_agent', arguments: '{}', status: 'completed' }],
    })
    vi.mocked(api.listOperations).mockResolvedValue({
      operations: [{
        id: 'operation-1',
        sessionId: SESSION_ID,
        workspaceId: '66666666-6666-4666-8666-666666666666',
        runId: RUN_ID,
        kind: 'chat',
        source: 'ui',
        actorType: 'user',
        status: 'completed',
      }],
      page: 0,
      size: 50,
      totalElements: 1,
      totalPages: 1,
    })
    vi.mocked(api.getOperationTrace).mockResolvedValue({
      operation: {
        id: 'operation-1',
        sessionId: SESSION_ID,
        workspaceId: '66666666-6666-4666-8666-666666666666',
        runId: RUN_ID,
        kind: 'chat',
        source: 'ui',
        actorType: 'user',
        status: 'completed',
      },
      items: [{
        id: 'item-1',
        operationId: 'operation-1',
        toolCallId: 'spawn-tool-call',
        sequence: 1,
        kind: 'tool_call',
        toolName: 'spawn_agent',
        source: 'agent',
        waitingOnRunId: derivedState.activeChildren[0].runId,
        status: 'running',
      }],
      attempts: [],
      events: [],
    })

    const stream = wrapper.findComponent(SSEStream)
    stream.vm.$emit('derivedStateRefresh')
    await flushPromises()

    expect(response).toHaveBeenCalledTimes(2)
    expect(api.listOperations).toHaveBeenCalledWith({ sessionId: SESSION_ID, page: 0, size: 50 })
    const rendered = wrapper.findComponent(MessageList).props('messages') as Array<{
      id: string
      toolCalls?: Array<{ waitingOn?: { childRunId: string; name: string | null; status: string } | null }>
    }>
    expect(rendered.find((message) => message.id === 'message-tool-call')?.toolCalls?.[0]?.waitingOn).toEqual({
      childRunId: derivedState.activeChildren[0].runId,
      name: 'Research child',
      status: 'running',
    })
  })
})
