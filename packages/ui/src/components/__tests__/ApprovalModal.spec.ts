import { describe, it, expect, beforeEach, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import ApprovalModal from '../chat/ApprovalModal.vue'
import { ApiError, api } from '../../composables/api'
import type { ApprovalPolicyShape, ApprovalRequest } from '../../types'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      upsertPolicyToolFace: vi.fn(),
    },
  }
})

const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const RUN_ID = '33333333-3333-4333-8333-333333333333'
const SESSION_ID = '44444444-4444-4444-8444-444444444444'

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      chat: {
        approvalRequired: 'Approval Required',
        approvalDescription: 'Review this action',
        approvalAction: 'Action',
        approvalDetails: 'Parameter preview',
        approvalEvidence: 'Policy evidence',
        approvalEvidenceActionClass: 'Action class',
        approvalEvidenceShape: 'Tool shape',
        approvalEvidenceMatchedRule: 'Matched rule',
        approvalEvidenceSourceLayer: 'Effective layer',
        approvalEvidenceReason: 'Reason',
        approvalEvidenceMode: 'Mode',
        approvalEvidenceModeAtGrant: 'Mode at decision',
        approvalEvidenceUnavailable: 'Policy evidence unavailable',
        approvalOriginCpGate: 'Policy gate',
        approvalOriginAgentRelay: 'Model request',
        approvalNoMatchedRule: 'No specific rule matched',
        approvalLayerBuiltin: 'Built-in layer',
        approvalLayerInstance: 'Instance layer',
        approvalLayerUser: 'User layer',
        approvalLayerWorkspace: 'Workspace layer',
        approvalLayerSession: 'Session layer',
        approvalLayerPerCall: 'Per-call layer',
        approvalModeManual: 'Manual approval',
        approvalModeAuto: 'Auto allow',
        
        
        
        approvalModeUnavailable: 'Not provided',
        approvalShapeStructured: 'Structured',
        approvalShapeInterpreter: 'Interpreter',
        approvalShapeOpaque: 'Opaque',
        approvalShapeInterpreterWarning: 'Interpreter warning',
        approvalShapeOpaqueWarning: 'Opaque warning',
        approvalTierGateDelete: 'Delete actions only allow once',
        approvalTierGateOpaque: 'Opaque tools only allow once',
        approvalTierGateInterpreter: 'Interpreter tools cannot save persistent rules',
        approvalTierGateShapeUnavailable: 'Shape evidence unavailable; only allow once is offered',
        approvalAllowOnce: 'Allow once',
        approvalAllowSession: 'Allow in this session',
        approvalSaveRule: 'Save as rule',
        approvalRejectFeedbackLabel: 'Rejection feedback',
        approvalRejectFeedbackOptional: 'Optional feedback',
        approvalRejectFeedbackTooLong: 'Feedback too long',
        approvalRejectFeedbackPlaceholder: 'Why reject?',
        approvalSaveRuleTitle: 'Confirm saved rule',
        approvalSaveRuleDescription: 'Choose scope',
         approvalRuleLayer: 'Save to layer',
         approvalRuleResource: 'Resource range',
         approvalRuleResourceUnset: 'Not set',
         approvalRuleResourceRequired: 'Enter a non-blank resource range.',
         approvalRuleResourceTooLong: 'Resource range too long',
         approvalRuleWildcardConfirmation: 'Confirm all resources',
         approvalRuleWildcardConfirmationRequired: 'Confirm all resources explicitly',
         approvalRulePreview: 'Rule preview',
        approvalRuleEffect: 'Effect',
        approvalRuleAllow: 'Allow',
        approvalRuleActionClassDerived: 'Derived by server',
        approvalPersistentWarning: 'Persistent warning',
        approvalPreflightUnavailable: 'Preflight unavailable',
        approvalSaveBack: 'Back',
        approvalSaveConfirm: 'Confirm save',
        reject: 'Reject',
        approvalUnclassifiedNotice: 'Unclassified tool defaults to ask; only an owner or admin can classify it.',
        approvalClassifyAndAllow: 'Classify and allow',
        approvalClassifyTitle: 'Classify the tool and allow this call',
        approvalClassifyDescription: 'Classification is persisted and this approval applies once.',
        approvalClassifyActionClass: 'Action class',
        approvalClassifyActionClassPlaceholder: 'e.g. read',
        approvalClassifyActionClassRequired: 'Enter an action class.',
        approvalClassifyShape: 'Tool shape',
        approvalClassifyAuthorityHint: 'Classification authority: workspace OWNER / ADMIN.',
        approvalClassifyBack: 'Back',
        approvalClassifySubmit: 'Confirm classification and allow once',
        approvalClassifyFailed: 'Classification failed',
        approvalClassifyRequiresOnce: 'Unclassified tools can only be allowed once.',
      },
      common: { saving: 'Saving...' },
    },
  },
})

const baseApproval: ApprovalRequest = {
  requestId: REQUEST_ID,
  runId: RUN_ID,
  sessionId: SESSION_ID,
  tool: 'write_file',
  action: 'write file',
  details: '/test.txt',
  state: 'pending',
}

const policy = {
  effect: 'ask' as const,
  sourceLayer: 'workspace' as const,
  matchedRule: 'write:/test.txt',
  reason: 'No allow rule matched',
  mode: 'manual' as const,
  actionClass: 'write',
  shape: 'structured' as const,
}

function mountModal(props: {
  approval: ApprovalRequest | null
  show: boolean
  busy?: boolean
  error?: string | null
  canClassify?: boolean
}) {
  return mount(ApprovalModal, { props, global: { plugins: [i18n] } })
}

const unclassifiedPolicy = {
  ...policy,
  actionClass: 'unclassified',
  shape: 'opaque' as const,
}

type ToolFaceWriteResult = Awaited<ReturnType<typeof api.upsertPolicyToolFace>>

function classifiedFace(overrides: Partial<ToolFaceWriteResult> = {}): ToolFaceWriteResult {
  return {
    id: 'face-1',
    scope: 'workspace',
    ownerId: 'workspace-1',
    tool: 'mcp__third_party__do',
    actionClass: 'read',
    shape: 'opaque',
    ...overrides,
  }
}

function deferredToolFaceWrite() {
  let resolveWrite!: (value: ToolFaceWriteResult) => void
  const promise = new Promise<ToolFaceWriteResult>((resolve) => {
    resolveWrite = resolve
  })
  return {
    promise,
    resolve: (value: ToolFaceWriteResult) => resolveWrite(value),
  }
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
})

describe('ApprovalModal', () => {
  it('renders the tool, action, details, and policy evidence fields', () => {
    const wrapper = mountModal({ approval: { ...baseApproval, policy: { ...policy, modeAtGrant: 'manual' } }, show: true })

    expect(wrapper.find('[data-testid="approval-tool"]').text()).toBe('write_file')
    expect(wrapper.find('[data-testid="approval-action"]').text()).toContain('write file')
    expect(wrapper.find('[data-testid="approval-details"]').text()).toContain('/test.txt')
    expect(wrapper.find('[data-testid="approval-evidence-action-class"]').text()).toBe('write')
    expect(wrapper.find('[data-testid="approval-evidence-shape"]').text()).toBe('Structured')
    expect(wrapper.find('[data-testid="approval-evidence-matched-rule"]').text()).toBe('write:/test.txt')
    expect(wrapper.find('[data-testid="approval-evidence-source-layer"]').text()).toBe('Workspace layer')
    expect(wrapper.find('[data-testid="approval-evidence-reason"]').text()).toContain('No allow rule matched')
    expect(wrapper.find('[data-testid="approval-evidence-mode"]').text()).toBe('Manual approval')
    expect(wrapper.find('[data-testid="approval-evidence-mode-at-grant"]').text()).toBe('Manual approval')
  })

  it('states explicitly when policy evidence is missing', () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })

    expect(wrapper.find('[data-testid="approval-evidence-unavailable"]').text()).toContain('unavailable')
    expect(wrapper.find('[data-testid="approval-evidence"]').exists()).toBe(false)
  })

  it('renders the durable origin badge for relayed model requests', () => {
    const wrapper = mountModal({ approval: { ...baseApproval, origin: 'agent_relay' }, show: true })

    expect(wrapper.find('[data-testid="approval-origin"]').text()).toBe('Model request')
  })

  it('renders the policy-gate badge and stays quiet for legacy rows', () => {
    const gated = mountModal({ approval: { ...baseApproval, origin: 'cp_gate' }, show: true })
    expect(gated.find('[data-testid="approval-origin"]').text()).toBe('Policy gate')

    const legacy = mountModal({ approval: { ...baseApproval, origin: null }, show: true })
    expect(legacy.find('[data-testid="approval-origin"]').exists()).toBe(false)

    const missing = mountModal({ approval: baseApproval, show: true })
    expect(missing.find('[data-testid="approval-origin"]').exists()).toBe(false)
  })

  it('marks dispatch_unknown recovery as retryable without submitting on mount', () => {
    const wrapper = mountModal({ approval: { ...baseApproval, state: 'dispatch_unknown' }, show: true })

    expect(wrapper.find('[data-testid="approval-retry-warning"]').text()).toContain('retry')
    expect(wrapper.emitted('approve')).toBeUndefined()
    expect(wrapper.emitted('reject')).toBeUndefined()
  })

  it('shows top-level mode-at-grant evidence without relabeling ask-time mode', () => {
    const wrapper = mountModal({ approval: { ...baseApproval, modeAtGrant: 'manual' }, show: true })

    expect(wrapper.find('[data-testid="approval-evidence-mode-at-grant"]').text()).toBe('Manual approval')
    expect(wrapper.find('[data-testid="approval-evidence-unavailable"]').exists()).toBe(false)
  })

  it('focuses once and emits a structured once decision', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })
    const onceButton = wrapper.find<HTMLButtonElement>('[data-testid="approval-approve"]')
    expect(onceButton.exists()).toBe(true)
    await onceButton.trigger('click')

    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once', requestId: REQUEST_ID }]])
  })

  it('emits a session-scoped decision', async () => {
    const wrapper = mountModal({ approval: { ...baseApproval, policy }, show: true })
    await wrapper.find('[data-testid="approval-allow-session"]').trigger('click')

    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'session', requestId: REQUEST_ID }]])
  })

  it('keeps saved-rule confirmation inside the same modal and sends only the edited resource', async () => {
    const wrapper = mountModal({ approval: { ...baseApproval, policy }, show: true })
    await wrapper.find('[data-testid="approval-save-rule"]').trigger('click')

    expect(wrapper.find('[data-testid="approval-save-confirm"]').exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="modal-content"]')).toHaveLength(1)

    await wrapper.find('[data-testid="approval-rule-layer"]').setValue('user')
    await wrapper.find('[data-testid="approval-rule-resource"]').setValue('src/**/*.ts')
    expect(wrapper.find('[data-testid="approval-rule-preview"]').text()).toContain('src/**/*.ts')
    await wrapper.find('[data-testid="approval-save-confirm-button"]').trigger('click')

    expect(wrapper.emitted('approve')).toEqual([[
      { decision: 'saved', layer: 'user', rule: { resource: 'src/**/*.ts' }, requestId: REQUEST_ID },
    ]])
  })

  it('submits optional rejection feedback as a structured decision', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })
    await wrapper.find('[data-testid="approval-feedback"]').setValue('  I need a narrower path  ')
    await wrapper.find('[data-testid="approval-reject"]').trigger('click')

    expect(wrapper.emitted('reject')).toEqual([[
      { decision: 'reject', feedback: 'I need a narrower path', requestId: REQUEST_ID },
    ]])
  })

  it('does not submit feedback beyond the server limit', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })
    await wrapper.find('[data-testid="approval-feedback"]').setValue('x'.repeat(513))

    expect(wrapper.find('[data-testid="approval-reject"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="approval-reject"]').trigger('click')
    expect(wrapper.emitted('reject')).toBeUndefined()
  })

  it('turns the normal close action into one structured rejection', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })
    await wrapper.find('[data-testid="approval-feedback"]').setValue('  \n  ')

    await wrapper.find('button[aria-label="Close"]').trigger('click')

    expect(wrapper.emitted('reject')).toEqual([[{ decision: 'reject', requestId: REQUEST_ID }]])
  })

  it('rejects on Escape without granting the approval', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(wrapper.emitted('reject')).toEqual([[{ decision: 'reject', requestId: REQUEST_ID }]])
    expect(wrapper.emitted('approve')).toBeUndefined()
  })

  it('does not offer saved rules without structured policy evidence', async () => {
    const wrapper = mountModal({
      approval: {
        ...baseApproval,
        policy: { ...policy, shape: 'interpreter' },
      },
      show: true,
    })
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(false)

    await wrapper.setProps({ approval: baseApproval })
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(false)
  })

  it('requires nonblank resources and explicit wildcard confirmation', async () => {
    const wrapper = mountModal({ approval: { ...baseApproval, policy }, show: true })
    await wrapper.find('[data-testid="approval-save-rule"]').trigger('click')

    const confirm = wrapper.find('[data-testid="approval-save-confirm-button"]')
    expect(confirm.attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="approval-rule-resource"]').setValue('*')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="approval-rule-wildcard-confirm"]').exists()).toBe(true)
    expect(confirm.attributes('disabled')).toBeDefined()

    await wrapper.find('[data-testid="approval-rule-wildcard-confirm"]').setValue(true)
    await confirm.trigger('click')
    expect(wrapper.emitted('approve')).toEqual([[
      { decision: 'saved', layer: 'workspace', rule: { resource: '*' }, requestId: REQUEST_ID },
    ]])
  })

  it('does not submit a resource beyond the server limit', async () => {
    const wrapper = mountModal({ approval: { ...baseApproval, policy }, show: true })
    await wrapper.find('[data-testid="approval-save-rule"]').trigger('click')
    await wrapper.find('[data-testid="approval-rule-resource"]').setValue('x'.repeat(513))

    expect(wrapper.find('[data-testid="approval-save-confirm-button"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="approval-save-confirm-button"]').trigger('click')
    expect(wrapper.emitted('approve')).toBeUndefined()
  })

  it('traps focus within its own teleported modal when another modal is open', async () => {
    const mountAttached = (requestId: string) => mount(ApprovalModal, {
      props: { approval: { ...baseApproval, requestId }, show: true },
      attachTo: document.body,
      global: { plugins: [i18n] },
    })
    const first = mountAttached(REQUEST_ID)
    const second = mountAttached(SECOND_REQUEST_ID)
    await nextTick()

    const secondLast = second.find('[data-testid="approval-reject"]')
    secondLast.element.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))

    expect(document.activeElement).toBe(second.find('button[aria-label="Close"]').element)
    first.unmount()
    second.unmount()
  })

  it('disables every decision and emits no duplicate event while busy', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true, busy: true })
    const decisionButtons = wrapper.findAll('button').filter((button) => button.attributes('data-testid')?.startsWith('approval-'))
    expect(decisionButtons.length).toBeGreaterThan(0)
    expect(decisionButtons.every((button) => button.attributes('disabled') !== undefined)).toBe(true)

    await wrapper.find('[data-testid="approval-approve"]').trigger('click')
    expect(wrapper.emitted('approve')).toBeUndefined()

    await wrapper.setProps({ busy: false })
    await wrapper.find('[data-testid="approval-approve"]').trigger('click')
    await wrapper.find('[data-testid="approval-approve"]').trigger('click')
    expect(wrapper.emitted('approve')).toHaveLength(1)
  })

  it('does not render when show is false', () => {
    const wrapper = mountModal({ approval: baseApproval, show: false })
    expect(wrapper.find('[class*="fixed"]').exists()).toBe(false)
  })
})

describe('ApprovalModal reuse-tier gating (PLAN-0328 T1.7)', () => {
  it('offers once, session and saved for structured non-delete tools with no gate reason', () => {
    const wrapper = mountModal({ approval: { ...baseApproval, policy }, show: true })

    expect(wrapper.find('[data-testid="approval-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-tier-gate-reason"]').exists()).toBe(false)
  })

  it('offers only once and explains the missing shape evidence when policy is absent', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })

    expect(wrapper.find('[data-testid="approval-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-tier-gate-reason"]').text()).toBe('Shape evidence unavailable; only allow once is offered')

    await wrapper.find('[data-testid="approval-approve"]').trigger('click')
    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once', requestId: REQUEST_ID }]])
  })

  it('fails closed to once only for a shape outside the contract', () => {
    const wrapper = mountModal({
      approval: { ...baseApproval, policy: { ...policy, shape: 'legacy' as ApprovalPolicyShape } },
      show: true,
    })

    expect(wrapper.find('[data-testid="approval-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-tier-gate-reason"]').text()).toBe('Shape evidence unavailable; only allow once is offered')
    // The out-of-contract value renders verbatim instead of failing the label lookup.
    expect(wrapper.find('[data-testid="approval-evidence-shape"]').text()).toBe('legacy')
  })

  it('keeps once and session, hides saved, and explains the ceiling for interpreter shapes', () => {
    const wrapper = mountModal({
      approval: { ...baseApproval, policy: { ...policy, shape: 'interpreter' } },
      show: true,
    })

    expect(wrapper.find('[data-testid="approval-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-tier-gate-reason"]').text()).toBe('Interpreter tools cannot save persistent rules')
  })

  it('offers only once and explains the ceiling for opaque shapes', () => {
    const wrapper = mountModal({
      approval: { ...baseApproval, policy: { ...policy, shape: 'opaque' } },
      show: true,
    })

    expect(wrapper.find('[data-testid="approval-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-tier-gate-reason"]').text()).toBe('Opaque tools only allow once')
  })

  it('offers only once and explains the ceiling for structured delete actions', async () => {
    const wrapper = mountModal({
      approval: { ...baseApproval, policy: { ...policy, actionClass: 'delete' } },
      show: true,
    })

    expect(wrapper.find('[data-testid="approval-approve"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-tier-gate-reason"]').text()).toBe('Delete actions only allow once')

    await wrapper.find('[data-testid="approval-approve"]').trigger('click')
    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once', requestId: REQUEST_ID }]])
  })

  it('keeps unclassified tools on the existing notice without duplicating the gate reason', () => {
    const wrapper = mountModal({ approval: { ...baseApproval, policy: unclassifiedPolicy }, show: true })

    expect(wrapper.find('[data-testid="approval-unclassified-notice"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-tier-gate-reason"]').exists()).toBe(false)
  })
})

describe('ApprovalModal unclassified classification (PLAN-0328 T1.14)', () => {
  beforeEach(() => {
    vi.mocked(api.upsertPolicyToolFace).mockReset()
  })

  it('offers the classify entry only to authorized users and never auto-approves', async () => {
    const wrapper = mountModal({
      approval: { ...baseApproval, policy: unclassifiedPolicy },
      show: true,
      canClassify: true,
    })
    await nextTick()

    expect(wrapper.find('[data-testid="approval-unclassified-notice"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-classify-entry"]').exists()).toBe(true)
    // Unclassified tools can never materialize session or saved rules.
    expect(wrapper.find('[data-testid="approval-allow-session"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-save-rule"]').exists()).toBe(false)
    expect(wrapper.emitted('approve')).toBeUndefined()
    expect(wrapper.emitted('reject')).toBeUndefined()

    await wrapper.setProps({ canClassify: false })
    expect(wrapper.find('[data-testid="approval-classify-entry"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-unclassified-notice"]').exists()).toBe(true)
  })

  it('classifies the tool first and only then emits a one-shot approve', async () => {
    vi.mocked(api.upsertPolicyToolFace).mockResolvedValue({
      id: 'face-1',
      scope: 'workspace',
      ownerId: 'workspace-1',
      tool: 'mcp__third_party__do',
      actionClass: 'read',
      shape: 'structured',
    })
    const wrapper = mountModal({
      approval: { ...baseApproval, tool: 'mcp__third_party__do', policy: unclassifiedPolicy },
      show: true,
      canClassify: true,
    })

    await wrapper.find('[data-testid="approval-classify-entry"]').trigger('click')
    expect(wrapper.find('[data-testid="approval-classify-confirm"]').exists()).toBe(true)
    expect(api.upsertPolicyToolFace).not.toHaveBeenCalled()
    expect(wrapper.emitted('approve')).toBeUndefined()

    expect(wrapper.find('[data-testid="approval-classify-submit"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="approval-classify-action-class"]').setValue('read')
    await wrapper.find('[data-testid="approval-classify-shape"]').setValue('structured')
    await wrapper.find('[data-testid="approval-classify-submit"]').trigger('click')
    await flushPromises()

    expect(api.upsertPolicyToolFace).toHaveBeenCalledWith({
      scope: 'workspace',
      tool: 'mcp__third_party__do',
      actionClass: 'read',
      shape: 'structured',
    })
    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once', requestId: REQUEST_ID }]])
    expect(wrapper.emitted('reject')).toBeUndefined()
  })

  it('does not approve when classification fails and keeps the step usable', async () => {
    vi.mocked(api.upsertPolicyToolFace).mockRejectedValueOnce(new ApiError({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'classification requires workspace OWNER or ADMIN',
      requestId: 'test',
    }))
    const wrapper = mountModal({
      approval: { ...baseApproval, tool: 'mcp__third_party__do', policy: unclassifiedPolicy },
      show: true,
      canClassify: true,
    })

    await wrapper.find('[data-testid="approval-classify-entry"]').trigger('click')
    await wrapper.find('[data-testid="approval-classify-action-class"]').setValue('read')
    await wrapper.find('[data-testid="approval-classify-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="approval-classify-confirm"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="approval-classify-error"]').text()).toContain('FORBIDDEN')
    expect(wrapper.emitted('approve')).toBeUndefined()

    // The failure releases the submit guard and the same request can be classified again.
    expect(wrapper.find('[data-testid="approval-classify-submit"]').attributes('disabled')).toBeUndefined()
    vi.mocked(api.upsertPolicyToolFace).mockResolvedValueOnce({
      id: 'face-1',
      scope: 'workspace',
      ownerId: 'workspace-1',
      tool: 'mcp__third_party__do',
      actionClass: 'read',
      shape: 'structured',
    })
    await wrapper.find('[data-testid="approval-classify-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once', requestId: REQUEST_ID }]])
  })

  it('does not freeze the next request after a failed classification', async () => {
    vi.mocked(api.upsertPolicyToolFace).mockRejectedValueOnce(new ApiError({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'classification requires workspace OWNER or ADMIN',
      requestId: 'test',
    }))
    const wrapper = mountModal({
      approval: { ...baseApproval, tool: 'mcp__third_party__do', policy: unclassifiedPolicy },
      show: true,
      canClassify: true,
    })

    await wrapper.find('[data-testid="approval-classify-entry"]').trigger('click')
    await wrapper.find('[data-testid="approval-classify-action-class"]').setValue('read')
    await wrapper.find('[data-testid="approval-classify-submit"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="approval-classify-error"]').exists()).toBe(true)

    await wrapper.setProps({
      approval: { ...baseApproval, requestId: SECOND_REQUEST_ID, tool: 'mcp__third_party__do', policy: unclassifiedPolicy },
    })
    vi.mocked(api.upsertPolicyToolFace).mockResolvedValueOnce({
      id: 'face-2',
      scope: 'workspace',
      ownerId: 'workspace-1',
      tool: 'mcp__third_party__do',
      actionClass: 'read',
      shape: 'opaque',
    })

    expect(wrapper.find('[data-testid="approval-classify-confirm"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-classify-error"]').exists()).toBe(false)
    await wrapper.find('[data-testid="approval-classify-entry"]').trigger('click')
    await wrapper.find('[data-testid="approval-classify-action-class"]').setValue('read')
    await wrapper.find('[data-testid="approval-classify-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once', requestId: SECOND_REQUEST_ID }]])
  })

  it('aborts a classification whose request changed while the write was in flight', async () => {
    const pendingWrite = deferredToolFaceWrite()
    vi.mocked(api.upsertPolicyToolFace).mockReturnValueOnce(pendingWrite.promise)
    const wrapper = mountModal({
      approval: { ...baseApproval, tool: 'mcp__third_party__do', policy: unclassifiedPolicy },
      show: true,
      canClassify: true,
    })

    await wrapper.find('[data-testid="approval-classify-entry"]').trigger('click')
    await wrapper.find('[data-testid="approval-classify-action-class"]').setValue('read')
    await wrapper.find('[data-testid="approval-classify-submit"]').trigger('click')
    expect(wrapper.find('[data-testid="approval-classify-submit"]').attributes('disabled')).toBeDefined()

    await wrapper.setProps({
      approval: { ...baseApproval, requestId: SECOND_REQUEST_ID, tool: 'mcp__third_party__do', policy: unclassifiedPolicy },
    })
    pendingWrite.resolve(classifiedFace())
    await flushPromises()

    expect(wrapper.emitted('approve')).toBeUndefined()
    expect(wrapper.emitted('reject')).toBeUndefined()
    // No state leak: the stale write neither keeps the step busy nor blocks the new request.
    expect(wrapper.find('[data-testid="approval-classify-entry"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="approval-approve"]').attributes('disabled')).toBeUndefined()

    vi.mocked(api.upsertPolicyToolFace).mockResolvedValueOnce(classifiedFace())
    await wrapper.find('[data-testid="approval-classify-entry"]').trigger('click')
    await wrapper.find('[data-testid="approval-classify-action-class"]').setValue('read')
    await wrapper.find('[data-testid="approval-classify-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once', requestId: SECOND_REQUEST_ID }]])
  })

  it('cancels an in-flight classification with Escape without emitting or sticking', async () => {
    const pendingWrite = deferredToolFaceWrite()
    vi.mocked(api.upsertPolicyToolFace).mockReturnValueOnce(pendingWrite.promise)
    const wrapper = mountModal({
      approval: { ...baseApproval, tool: 'mcp__third_party__do', policy: unclassifiedPolicy },
      show: true,
      canClassify: true,
    })

    await wrapper.find('[data-testid="approval-classify-entry"]').trigger('click')
    await wrapper.find('[data-testid="approval-classify-action-class"]').setValue('read')
    await wrapper.find('[data-testid="approval-classify-submit"]').trigger('click')
    expect(wrapper.find('[data-testid="approval-classify-submit"]').attributes('disabled')).toBeDefined()

    await wrapper.find('.approval-content').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="approval-classify-confirm"]').exists()).toBe(false)

    pendingWrite.resolve(classifiedFace())
    await flushPromises()

    expect(wrapper.emitted('approve')).toBeUndefined()
    expect(wrapper.emitted('reject')).toBeUndefined()

    // The cancelled step is fully released: a fresh classify can still allow once.
    vi.mocked(api.upsertPolicyToolFace).mockResolvedValueOnce(classifiedFace())
    await wrapper.find('[data-testid="approval-classify-entry"]').trigger('click')
    await wrapper.find('[data-testid="approval-classify-action-class"]').setValue('read')
    await wrapper.find('[data-testid="approval-classify-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once', requestId: REQUEST_ID }]])
  })

  it('returns to the decision view on Escape without rejecting', async () => {
    const wrapper = mountModal({
      approval: { ...baseApproval, policy: unclassifiedPolicy },
      show: true,
      canClassify: true,
    })

    await wrapper.find('[data-testid="approval-classify-entry"]').trigger('click')
    await wrapper.find('[data-testid="approval-classify-action-class"]').trigger('keydown', { key: 'Escape' })

    expect(wrapper.find('[data-testid="approval-classify-confirm"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="approval-classify-entry"]').exists()).toBe(true)
    expect(wrapper.emitted('reject')).toBeUndefined()
    expect(wrapper.emitted('approve')).toBeUndefined()
  })

  it('keeps the plain once/reject flow for unclassified tools without authority', async () => {
    const wrapper = mountModal({
      approval: { ...baseApproval, policy: unclassifiedPolicy },
      show: true,
      canClassify: false,
    })
    await wrapper.find('[data-testid="approval-approve"]').trigger('click')

    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once', requestId: REQUEST_ID }]])
  })
})
