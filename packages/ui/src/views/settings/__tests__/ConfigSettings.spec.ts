import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { i18n } from '../../../i18n'
import { INSTANCE_DOMAINS, LAYER_DOMAINS } from '../../../stores/config'

vi.mock('vue-router', () => ({
  useRoute: () =>
    ({
      name: 'settings-config',
      path: '/settings/config',
      params: {},
      query: {},
      hash: '',
      fullPath: '/settings/config',
      matched: [],
      redirectedFrom: undefined,
      meta: {},
    }) as RouteLocationNormalizedLoaded,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  RouterLink: { template: '<a><slot /></a>' },
}))

vi.mock('vue-sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

const WORKSPACE_ID = '66666666-6666-4666-8666-666666666666'

/**
 * PLAN-0373 T2.2：job-policy 域表单渲染、env 锁定态来源徽标、三层域列表可见性。
 * fetch 返回 layer envelope；job-policy 模拟 env 注入（defaultTimeoutSecs 锁定为 7200）。
 */
function mockConfigFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input.url
    const parsed = new URL(url, 'http://localhost')
    const domain = parsed.pathname.split('/').pop() ?? ''
    const layer = parsed.searchParams.get('layer')
    if (!layer) {
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }))
    }
    const entries = domain === 'job-policy'
      ? { defaultTimeoutSecs: '3600', maxTimeoutSecs: '0' }
      : {}
    const envOverridden = domain === 'job-policy'
      ? { defaultTimeoutSecs: '7200' }
      : {}
    return Promise.resolve(
      new Response(JSON.stringify({ domain, entries, envOverridden }), { status: 200 }),
    )
  })
}

async function mountView() {
  const { default: ConfigSettings } = await import('../ConfigSettings.vue')
  const wrapper = mount(ConfigSettings, {
    global: {
      plugins: [i18n],
      stubs: { ProviderHub: true, McpStdioServerList: true },
    },
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  localStorage.setItem('xihe-token', 'test-token')
  localStorage.setItem(
    'xihe-user',
    JSON.stringify({ id: 'u1', email: 'admin@xihe.local', role: 'ADMIN' }),
  )
  localStorage.setItem(
    'xihe-workspace',
    JSON.stringify({ id: WORKSPACE_ID, name: 'Workspace' }),
  )
  mockConfigFetch()
})

describe('ConfigSettings job-policy (PLAN-0373)', () => {
  it('store domain lists register job-policy on instance+workspace only', () => {
    expect(INSTANCE_DOMAINS).toContain('job-policy')
    expect(LAYER_DOMAINS.instance).toContain('job-policy')
    expect(LAYER_DOMAINS.workspace).toContain('job-policy')
    expect(LAYER_DOMAINS.user).not.toContain('job-policy')
  })

  it('renders the job-policy panel with both fields on the instance tab', async () => {
    const wrapper = await mountView()

    const panel = wrapper.find('[data-testid="config-domain-job-policy"]')
    expect(panel.exists()).toBe(true)
    await panel.find('button').trigger('click')

    const defaultField = wrapper.find('[data-testid="config-field-job-policy-defaultTimeoutSecs"]')
    const maxField = wrapper.find('[data-testid="config-field-job-policy-maxTimeoutSecs"]')
    expect(defaultField.exists()).toBe(true)
    expect(maxField.exists()).toBe(true)
    // defaultTimeoutSecs 被 env 注入锁定（mock 返回 7200），行内不渲染 input；
    // maxTimeoutSecs 保持可编辑。
    expect(defaultField.find('input').exists()).toBe(false)
    expect(maxField.find('input').exists()).toBe(true)
  })

  it('locks defaultTimeoutSecs behind the env badge and keeps maxTimeoutSecs editable', async () => {
    const wrapper = await mountView()

    const panel = wrapper.find('[data-testid="config-domain-job-policy"]')
    await panel.find('button').trigger('click')

    const lockedRow = wrapper.find('[data-testid="config-field-job-policy-defaultTimeoutSecs"]')
    const lock = wrapper.find('[data-testid="config-env-lock-job-policy-defaultTimeoutSecs"]')
    expect(lock.exists()).toBe(true)
    expect(lock.text()).toBe('7200')
    expect(lockedRow.find('input').exists()).toBe(false)
    // 来源徽标（env）与锁定值同行呈现，复用 approval-policy/embedding 的 env 呈现。
    const badge = lockedRow.findAll('span').find(span => span.text().toLowerCase() === 'env')
    expect(badge).toBeTruthy()

    const maxRow = wrapper.find('[data-testid="config-field-job-policy-maxTimeoutSecs"]')
    expect(maxRow.find('input').exists()).toBe(true)
  })

  it('shows job-policy on the workspace tab and hides it from the user tab', async () => {
    const wrapper = await mountView()

    await wrapper.find('[data-testid="config-tab-workspace"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="config-domain-job-policy"]').exists()).toBe(true)

    await wrapper.find('[data-testid="config-tab-user"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="config-domain-job-policy"]').exists()).toBe(false)
  })
})

describe('ConfigSettings Agent template and approval policy (PLAN-0374)', () => {
  it('registers agent-templates on all writable layers', () => {
    expect(INSTANCE_DOMAINS).toContain('agent-templates')
    expect(LAYER_DOMAINS.instance).toContain('agent-templates')
    expect(LAYER_DOMAINS.user).toContain('agent-templates')
    expect(LAYER_DOMAINS.workspace).toContain('agent-templates')
  })

  it('renders the structured template editor while keeping approval action classes in approval-policy', async () => {
    const wrapper = await mountView()

    const templatesPanel = wrapper.find('[data-testid="agent-templates-panel"]')
    expect(templatesPanel.exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-template-prompt"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-template-role"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-template-provider"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-template-model"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="agent-template-secret"]').exists()).toBe(false)

    const approvalPanel = wrapper.find('[data-testid="config-domain-approval-policy"]')
    expect(approvalPanel.exists()).toBe(true)
    await approvalPanel.find('button').trigger('click')
    expect(wrapper.find('[data-testid="config-field-approval-policy-askActionClasses"] textarea').exists()).toBe(true)
  })

  it('keeps approval-policy workspace-only while showing agent-templates in user settings', async () => {
    const wrapper = await mountView()

    await wrapper.find('[data-testid="config-tab-user"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="agent-templates-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="config-domain-approval-policy"]').exists()).toBe(false)
  })

  it('saves askActionClasses as a JSON array value through the selected config layer', async () => {
    const wrapper = await mountView()
    const panel = wrapper.find('[data-testid="config-domain-approval-policy"]')
    await panel.find('button').trigger('click')

    const field = wrapper.find('[data-testid="config-field-approval-policy-askActionClasses"] textarea')
    await field.setValue('["CREATE_TEMPLATE"]')
    const saveLabel = i18n.global.t('common.save')
    const saveButton = panel.findAll('button').find(button => button.text() === saveLabel)
    expect(saveButton).toBeTruthy()
    await saveButton!.trigger('click')
    await flushPromises()

    const request = vi.mocked(fetch).mock.calls.find(([input, init]) => {
      const url = typeof input === 'string' ? input : input.url
      return url.includes('/api/v1/config/instance/approval-policy') && init?.method === 'PUT'
    })
    expect(request).toBeTruthy()
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ askActionClasses: '["CREATE_TEMPLATE"]' })
  })
})
