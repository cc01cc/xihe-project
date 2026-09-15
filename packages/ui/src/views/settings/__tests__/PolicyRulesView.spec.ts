import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { i18n } from '../../../i18n'
import { ApiError, api } from '../../../composables/api'
import type { PolicyRuleView } from '../../../types'

vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'settings-policy', path: '/settings/policy', params: {}, query: {}, hash: '', fullPath: '/settings/policy', matched: [], redirectedFrom: undefined, meta: {} }) as RouteLocationNormalizedLoaded,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  RouterLink: { template: '<a><slot /></a>' },
}))

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('../../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listPolicyDomains: vi.fn(),
      listPolicyRules: vi.fn(),
      listPolicyRuleConflicts: vi.fn(),
      createPolicyRule: vi.fn(),
      deletePolicyRule: vi.fn(),
    },
  }
})

const RULE_ID = '77777777-7777-4777-8777-777777777777'
const WORKSPACE_OWNER = 'user-1'

const conflictedRule: PolicyRuleView = {
  id: RULE_ID,
  layer: 'user',
  ownerId: WORKSPACE_OWNER,
  actionClass: 'exec',
  resource: 'pnpm *',
  effect: 'allow',
  priority: 4,
  locked: true,
  effective: false,
  conflict: '该 allow 不会生效：存在更具体的 deny "pnpm test *"',
}

function seedUser(role?: string) {
  localStorage.setItem('xihe-user', JSON.stringify({ id: WORKSPACE_OWNER, email: 'test@xihe.local', ...(role ? { role } : {}) }))
}

async function mountView() {
  const { default: PolicyRulesView } = await import('../PolicyRulesView.vue')
  const wrapper = mount(PolicyRulesView, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.listPolicyDomains).mockResolvedValue([
    { actionClass: 'exec', effectiveLayer: 'user', configuredLayers: ['user'], ruleCounts: { user: 1 } },
    { actionClass: 'read', effectiveLayer: 'builtin', configuredLayers: [], ruleCounts: {} },
  ])
  vi.mocked(api.listPolicyRules).mockResolvedValue([])
  vi.mocked(api.listPolicyRuleConflicts).mockResolvedValue([])
})

describe('PolicyRulesView', () => {
  it('renders domains with their effective layer and expandable per-layer counts', async () => {
    seedUser()
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-policy-heading"]').text()).toContain('权限规则')
    expect(wrapper.find('[data-testid="settings-policy-domain-effective-exec"]').text()).toContain('用户层')
    expect(wrapper.find('[data-testid="settings-policy-domain-effective-read"]').text()).toContain('内置层')

    expect(wrapper.find('[data-testid="settings-policy-domain-detail-exec"]').exists()).toBe(false)
    await wrapper.find('[data-testid="settings-policy-domain-toggle-exec"]').trigger('click')
    expect(wrapper.find('[data-testid="settings-policy-domain-detail-exec"]').text()).toContain('1')
  })

  it('renders effect, effective state, locked marker and server conflict text per rule', async () => {
    seedUser()
    vi.mocked(api.listPolicyRules).mockResolvedValue([conflictedRule])
    vi.mocked(api.listPolicyRuleConflicts).mockResolvedValue([conflictedRule])
    const wrapper = await mountView()

    expect(wrapper.find(`[data-testid="settings-policy-rule-${RULE_ID}"]`).exists()).toBe(true)
    expect(wrapper.find(`[data-testid="settings-policy-rule-effect-${RULE_ID}"]`).text()).toBe('允许')
    expect(wrapper.find(`[data-testid="settings-policy-rule-not-effective-${RULE_ID}"]`).text()).toContain('更高层')
    expect(wrapper.find(`[data-testid="settings-policy-rule-locked-${RULE_ID}"]`).text()).toContain('已锁定')
    expect(wrapper.find(`[data-testid="settings-policy-rule-conflict-${RULE_ID}"]`).text()).toContain('更具体的 deny')
    expect(wrapper.find('[data-testid="settings-policy-conflict-summary"]').text()).toContain('冲突')
    expect(api.listPolicyRuleConflicts).toHaveBeenCalledWith('user')
  })

  it('shows the empty state when no custom rules exist', async () => {
    seedUser()
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-policy-empty"]').text()).toContain('未配置自定义规则')
    expect(wrapper.find('[data-testid="settings-policy-conflict-none"]').text()).toContain('未发现冲突')
  })

  it('does not claim "no conflicts" when the conflict check is unavailable', async () => {
    seedUser()
    vi.mocked(api.listPolicyRuleConflicts).mockRejectedValue(new Error('conflict endpoint down'))
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-policy-conflict-unavailable"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-policy-conflict-none"]').exists()).toBe(false)
  })

  it('surfaces a 403 layer rejection as an explicit forbidden notice', async () => {
    seedUser()
    vi.mocked(api.listPolicyRules).mockRejectedValue(new ApiError({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'workspace-layer rules require workspace OWNER or ADMIN',
      requestId: 'test',
    }))
    const wrapper = await mountView()
    await wrapper.find('[data-testid="settings-policy-layer-workspace"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="settings-policy-forbidden"]').text()).toContain('OWNER')
    expect(wrapper.find('[data-testid="settings-policy-error"]').text()).toContain('FORBIDDEN')
  })

  it('creates a rule for the active layer and sends the locked draft only for admins', async () => {
    seedUser('ADMIN')
    vi.mocked(api.createPolicyRule).mockResolvedValue({
      id: RULE_ID,
      layer: 'instance',
      ownerId: null,
      actionClass: 'exec',
      resource: 'pnpm *',
      effect: 'ask',
      priority: 2,
      locked: true,
      effective: true,
      conflict: null,
    })
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-policy-create-locked"]').exists()).toBe(true)
    await wrapper.find('[data-testid="settings-policy-create-action-class"]').setValue(' exec ')
    await wrapper.find('[data-testid="settings-policy-create-resource"]').setValue(' pnpm * ')
    await wrapper.find('[data-testid="settings-policy-create-effect"]').setValue('ask')
    await wrapper.find('[data-testid="settings-policy-create-priority"]').setValue(2)
    await wrapper.find('[data-testid="settings-policy-create-locked"]').setValue(true)
    await wrapper.find('[data-testid="settings-policy-create"]').trigger('submit')
    await flushPromises()

    expect(api.createPolicyRule).toHaveBeenCalledWith({
      layer: 'instance',
      actionClass: 'exec',
      resource: 'pnpm *',
      effect: 'ask',
      priority: 2,
      locked: true,
    })
    expect((wrapper.find('[data-testid="settings-policy-create-action-class"]').element as HTMLInputElement).value).toBe('')
  })

  it('does not hide the locked control for non-admins and never sends locked', async () => {
    seedUser()
    vi.mocked(api.createPolicyRule).mockResolvedValue({ ...conflictedRule, locked: false, conflict: null })
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-policy-create-locked"]').exists()).toBe(false)
    await wrapper.find('[data-testid="settings-policy-create-action-class"]').setValue('exec')
    await wrapper.find('[data-testid="settings-policy-create-resource"]').setValue('pnpm *')
    await wrapper.find('[data-testid="settings-policy-create"]').trigger('submit')
    await flushPromises()

    expect(api.createPolicyRule).toHaveBeenCalledWith(expect.objectContaining({ layer: 'user', locked: false }))
  })

  it('validates the create form before calling the API', async () => {
    seedUser()
    const wrapper = await mountView()

    await wrapper.find('[data-testid="settings-policy-create"]').trigger('submit')
    await flushPromises()

    expect(api.createPolicyRule).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="settings-policy-create-validation"]').text()).toContain('动作类别')
  })

  it('deletes a rule only after an explicit confirmation step', async () => {
    seedUser()
    vi.mocked(api.listPolicyRules).mockResolvedValue([{ ...conflictedRule, conflict: null, locked: false }])
    vi.mocked(api.deletePolicyRule).mockResolvedValue(undefined)
    const wrapper = await mountView()

    await wrapper.find(`[data-testid="settings-policy-rule-delete-${RULE_ID}"]`).trigger('click')
    expect(wrapper.find('[data-testid="settings-policy-delete-confirm"]').exists()).toBe(true)
    expect(api.deletePolicyRule).not.toHaveBeenCalled()

    await wrapper.find('[data-testid="settings-policy-delete-confirm"]').trigger('click')
    await flushPromises()

    expect(api.deletePolicyRule).toHaveBeenCalledWith(RULE_ID, 'user')
  })
})
