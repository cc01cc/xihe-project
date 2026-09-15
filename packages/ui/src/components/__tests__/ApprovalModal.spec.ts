import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import ApprovalModal from '../chat/ApprovalModal.vue'
import type { ApprovalRequest } from '../../types'

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
        approvalNoMatchedRule: 'No specific rule matched',
        approvalLayerBuiltin: 'Built-in layer',
        approvalLayerInstance: 'Instance layer',
        approvalLayerUser: 'User layer',
        approvalLayerWorkspace: 'Workspace layer',
        approvalLayerSession: 'Session layer',
        approvalLayerPerCall: 'Per-call layer',
        approvalModeDefault: 'Default',
        approvalModeBypass: 'Bypass',
        approvalModeManaged: 'Managed',
        approvalModeAcceptEdits: 'Accept edits',
        approvalModePlan: 'Plan',
        approvalModeUnavailable: 'Not provided',
        approvalShapeStructured: 'Structured',
        approvalShapeInterpreter: 'Interpreter',
        approvalShapeOpaque: 'Opaque',
        approvalShapeInterpreterWarning: 'Interpreter warning',
        approvalShapeOpaqueWarning: 'Opaque warning',
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
  mode: 'default' as const,
  actionClass: 'write',
  shape: 'structured' as const,
}

function mountModal(props: { approval: ApprovalRequest | null; show: boolean; busy?: boolean; error?: string | null }) {
  return mount(ApprovalModal, { props, global: { plugins: [i18n] } })
}

beforeEach(() => {
  i18n.global.locale.value = 'en'
})

describe('ApprovalModal', () => {
  it('renders the tool, action, details, and policy evidence fields', () => {
    const wrapper = mountModal({ approval: { ...baseApproval, policy: { ...policy, modeAtGrant: 'managed' } }, show: true })

    expect(wrapper.find('[data-testid="approval-tool"]').text()).toBe('write_file')
    expect(wrapper.find('[data-testid="approval-action"]').text()).toContain('write file')
    expect(wrapper.find('[data-testid="approval-details"]').text()).toContain('/test.txt')
    expect(wrapper.find('[data-testid="approval-evidence-action-class"]').text()).toBe('write')
    expect(wrapper.find('[data-testid="approval-evidence-shape"]').text()).toBe('Structured')
    expect(wrapper.find('[data-testid="approval-evidence-matched-rule"]').text()).toBe('write:/test.txt')
    expect(wrapper.find('[data-testid="approval-evidence-source-layer"]').text()).toBe('Workspace layer')
    expect(wrapper.find('[data-testid="approval-evidence-reason"]').text()).toContain('No allow rule matched')
    expect(wrapper.find('[data-testid="approval-evidence-mode"]').text()).toBe('Default')
    expect(wrapper.find('[data-testid="approval-evidence-mode-at-grant"]').text()).toBe('Managed')
  })

  it('states explicitly when policy evidence is missing', () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })

    expect(wrapper.find('[data-testid="approval-evidence-unavailable"]').text()).toContain('unavailable')
    expect(wrapper.find('[data-testid="approval-evidence"]').exists()).toBe(false)
  })

  it('marks dispatch_unknown recovery as retryable without submitting on mount', () => {
    const wrapper = mountModal({ approval: { ...baseApproval, state: 'dispatch_unknown' }, show: true })

    expect(wrapper.find('[data-testid="approval-retry-warning"]').text()).toContain('retry')
    expect(wrapper.emitted('approve')).toBeUndefined()
    expect(wrapper.emitted('reject')).toBeUndefined()
  })

  it('shows top-level mode-at-grant evidence without relabeling ask-time mode', () => {
    const wrapper = mountModal({ approval: { ...baseApproval, modeAtGrant: 'managed' }, show: true })

    expect(wrapper.find('[data-testid="approval-evidence-mode-at-grant"]').text()).toBe('Managed')
    expect(wrapper.find('[data-testid="approval-evidence-unavailable"]').exists()).toBe(false)
  })

  it('focuses once and emits a structured once decision', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })
    const onceButton = wrapper.find<HTMLButtonElement>('[data-testid="approval-approve"]')
    expect(onceButton.exists()).toBe(true)
    await onceButton.trigger('click')

    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'once' }]])
  })

  it('emits a session-scoped decision', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })
    await wrapper.find('[data-testid="approval-allow-session"]').trigger('click')

    expect(wrapper.emitted('approve')).toEqual([[{ decision: 'session' }]])
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
      { decision: 'saved', layer: 'user', rule: { resource: 'src/**/*.ts' } },
    ]])
  })

  it('submits optional rejection feedback as a structured decision', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })
    await wrapper.find('[data-testid="approval-feedback"]').setValue('  I need a narrower path  ')
    await wrapper.find('[data-testid="approval-reject"]').trigger('click')

    expect(wrapper.emitted('reject')).toEqual([[
      { decision: 'reject', feedback: 'I need a narrower path' },
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

    expect(wrapper.emitted('reject')).toEqual([[{ decision: 'reject' }]])
  })

  it('rejects on Escape without granting the approval', async () => {
    const wrapper = mountModal({ approval: baseApproval, show: true })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()

    expect(wrapper.emitted('reject')).toEqual([[{ decision: 'reject' }]])
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
      { decision: 'saved', layer: 'workspace', rule: { resource: '*' } },
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
