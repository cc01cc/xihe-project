import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { i18n } from '../../../i18n'
import { api } from '../../../composables/api'
import type { OperationItemView, OperationPolicyView, OperationTrace } from '../../../types'

vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'settings-audit', path: '/settings/audit', params: {}, query: {}, hash: '', fullPath: '/settings/audit', matched: [], redirectedFrom: undefined, meta: {} }) as RouteLocationNormalizedLoaded,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  RouterLink: { template: '<a><slot /></a>' },
}))

vi.mock('../../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listOperations: vi.fn(),
      getOperationTrace: vi.fn(),
    },
  }
})

// Exact values produced by CP OperationPolicySummary (PLAN-0328 T1.15). Bypass upgrades an
// ask rule to `effect: 'allow'` with a non-null allowedBy, so this fixture mirrors that verdict.
const POLICY: OperationPolicyView = {
  effect: 'allow',
  sourceLayer: 'builtin',
  matchedRule: '{ write, "*", ask }',
  reason: 'requires approval for domain write',
  mode: 'bypass',
  allowedBy: 'bypass@session',
  actionClass: 'write',
  shape: 'structured',
}

function traceWith(items: OperationItemView[]): OperationTrace {
  return {
    operation: { id: 'op-1', kind: 'chat', source: 'agent', actorType: 'agent', status: 'completed' },
    items,
    attempts: [{
      id: 'attempt-1',
      itemId: items[0]?.id ?? 'item-1',
      stage: 'agent_dispatch',
      retryNo: 0,
      module: 'agent',
      status: 'succeeded',
      durationMs: 125,
    }],
    events: [{
      id: 'event-1',
      operationId: 'op-1',
      sequence: 1,
      eventType: 'operation.started',
      state: 'running',
      actor: 'agent',
    }],
  }
}

function policyItem(overrides: Partial<OperationItemView> = {}): OperationItemView {
  return {
    id: 'item-1',
    operationId: 'op-1',
    toolCallId: 'call-bypass-1',
    sequence: 1,
    kind: 'tool_call',
    toolName: 'write_file',
    source: 'mcp',
    policyDecision: 'allow',
    status: 'completed',
    policy: POLICY,
    ...overrides,
  }
}

async function mountView() {
  const { default: AuditView } = await import('../AuditView.vue')
  const wrapper = mount(AuditView, { global: { plugins: [i18n] } })
  await flushPromises()
  await wrapper.find('[data-testid="settings-audit-operation-op-1"]').trigger('click')
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(api.listOperations).mockResolvedValue({
    operations: [{ id: 'op-1', kind: 'chat', source: 'agent', actorType: 'agent', status: 'completed' }],
    page: 0,
    size: 20,
    totalElements: 1,
    totalPages: 1,
  })
})

describe('AuditView policy verdict (PLAN-0328 T1.15)', () => {
  it('renders the server projection verbatim, keyed by toolCallId', async () => {
    vi.mocked(api.getOperationTrace).mockResolvedValue(traceWith([
      policyItem(),
      policyItem({
        id: 'item-ask',
        toolCallId: 'call-ask-2',
        policy: { ...POLICY, effect: 'ask', mode: 'default', allowedBy: null, matchedRule: '{ exec, "*", ask }' },
      }),
    ]))
    const wrapper = await mountView()

    const block = wrapper.find('[data-testid="settings-audit-policy-call-bypass-1"]')
    expect(block.exists()).toBe(true)
    expect(block.text()).toContain('策略判定')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-bypass-1-effect"]').text()).toBe('允许')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-bypass-1-matched-rule"]').text()).toBe('{ write, "*", ask }')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-bypass-1-source-layer"]').text()).toBe('内置层')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-bypass-1-mode"]').text()).toBe('免批')
    expect(block.text()).toContain('工具调用: call-bypass-1')

    // A plain ask verdict (no allowedBy) keeps the ask rendering.
    const ask = wrapper.find('[data-testid="settings-audit-policy-call-ask-2"]')
    expect(ask.exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-audit-policy-call-ask-2-effect"]').text()).toBe('询问')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-ask-2-matched-rule"]').text()).toBe('{ exec, "*", ask }')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-ask-2-source-layer"]').text()).toBe('内置层')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-ask-2-mode"]').text()).toBe('默认')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-ask-2-allowed-by"]').exists()).toBe(false)
  })

  it('highlights a mode-based allowance with the exact allowedBy value', async () => {
    vi.mocked(api.getOperationTrace).mockResolvedValue(traceWith([policyItem()]))
    const wrapper = await mountView()

    const allowedBy = wrapper.find('[data-testid="settings-audit-policy-call-bypass-1-allowed-by"]')
    expect(allowedBy.exists()).toBe(true)
    expect(allowedBy.text()).toContain('由 bypass 放行')
    expect(allowedBy.text()).toContain('bypass@session')
  })

  it('preserves nullable matchedRule, mode and allowedBy without fabricating verdict defaults', async () => {
    vi.mocked(api.getOperationTrace).mockResolvedValue(traceWith([policyItem({
      toolCallId: 'call-deny-2',
      policy: { ...POLICY, effect: 'deny', matchedRule: null, mode: null, allowedBy: null },
    })]))
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-audit-policy-call-deny-2-effect"]').text()).toBe('拒绝')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-deny-2-matched-rule"]').text()).toBe('未命中具体规则')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-deny-2-mode"]').text()).toBe('未提供')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-deny-2-allowed-by"]').exists()).toBe(false)
  })

  it('renders an explicit no-verdict state for legacy rows instead of a fake verdict', async () => {
    vi.mocked(api.getOperationTrace).mockResolvedValue(traceWith([policyItem({
      id: 'item-legacy',
      toolCallId: 'call-legacy-3',
      policy: undefined,
    })]))
    const wrapper = await mountView()

    const absent = wrapper.find('[data-testid="settings-audit-policy-absent-item-legacy"]')
    expect(absent.exists()).toBe(true)
    expect(absent.text()).toBe('无判定记录（旧记录或非 MCP 路径）')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-legacy-3"]').exists()).toBe(false)
  })

  it('marks a session-reuse dispatch with an icon and text, and never for null/absent/false', async () => {
    vi.mocked(api.getOperationTrace).mockResolvedValue(traceWith([
      policyItem({
        id: 'item-reuse',
        toolCallId: 'call-reuse-4',
        policy: { ...POLICY, effect: 'ask', mode: 'default', allowedBy: null, reused: true },
      }),
      policyItem({ id: 'item-reuse-null', toolCallId: 'call-reuse-null-5', policy: { ...POLICY, reused: null } }),
      policyItem({ id: 'item-reuse-false', toolCallId: 'call-reuse-false-6', policy: { ...POLICY, reused: false } }),
      policyItem({ id: 'item-reuse-absent', toolCallId: 'call-reuse-absent-7', policy: { ...POLICY } }),
    ]))
    const wrapper = await mountView()

    const reuse = wrapper.find('[data-testid="settings-audit-policy-call-reuse-4-reused"]')
    expect(reuse.exists()).toBe(true)
    expect(reuse.text()).toBe('由复用放行')
    // Not color-only: the marker carries an icon and the reuse text next to the verdict.
    expect(reuse.find('svg').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-audit-policy-call-reuse-4-effect"]').text()).toBe('询问')

    expect(wrapper.find('[data-testid="settings-audit-policy-call-reuse-null-5-reused"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="settings-audit-policy-call-reuse-false-6-reused"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="settings-audit-policy-call-reuse-absent-7-reused"]').exists()).toBe(false)
  })

  it('keeps reason, actionClass and shape inside the expandable detail', async () => {
    vi.mocked(api.getOperationTrace).mockResolvedValue(traceWith([policyItem()]))
    const wrapper = await mountView()

    const block = wrapper.find('[data-testid="settings-audit-policy-call-bypass-1"]')
    expect(block.find('details').exists()).toBe(true)
    expect(block.find('summary').text()).toBe('判定详情')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-bypass-1-reason"]').text()).toBe('requires approval for domain write')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-bypass-1-action-class"]').text()).toBe('write')
    expect(wrapper.find('[data-testid="settings-audit-policy-call-bypass-1-shape"]').text()).toBe('结构化')
  })

  it('keeps the existing attempts and events sections unchanged', async () => {
    vi.mocked(api.getOperationTrace).mockResolvedValue(traceWith([policyItem()]))
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-audit-events"]').text()).toContain('operation.started')
    expect(wrapper.text()).toContain('agent_dispatch')
    expect(wrapper.text()).toContain('125ms')
  })
})
