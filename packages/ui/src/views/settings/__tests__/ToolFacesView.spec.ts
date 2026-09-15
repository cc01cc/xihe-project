import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { i18n } from '../../../i18n'
import { ApiError, api } from '../../../composables/api'
import type { PolicyToolFaceView } from '../../../types'

vi.mock('vue-router', () => ({
  useRoute: () => ({ name: 'settings-tool-faces', path: '/settings/tool-faces', params: {}, query: {}, hash: '', fullPath: '/settings/tool-faces', matched: [], redirectedFrom: undefined, meta: {} }) as RouteLocationNormalizedLoaded,
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
      listPolicyToolFaces: vi.fn(),
      upsertPolicyToolFace: vi.fn(),
    },
  }
})

const FACE_ID = '88888888-8888-4888-8888-888888888888'
const USER_ID = 'user-1'
const WORKSPACE_ID = 'workspace-1'

const builtinFace: PolicyToolFaceView = {
  id: null,
  scope: 'builtin',
  ownerId: null,
  tool: 'read_file',
  actionClass: 'read',
  shape: 'structured',
}

const unclassifiedFace: PolicyToolFaceView = {
  id: FACE_ID,
  scope: 'workspace',
  ownerId: WORKSPACE_ID,
  tool: 'mcp__third_party__do',
  actionClass: 'unclassified',
  shape: 'opaque',
}

function seedIdentity(options: { admin?: boolean; workspaceOwner?: boolean } = {}) {
  localStorage.setItem('xihe-user', JSON.stringify({
    id: USER_ID,
    email: 'test@xihe.local',
    ...(options.admin ? { role: 'ADMIN' } : {}),
  }))
  localStorage.setItem('xihe-workspace', JSON.stringify({
    id: WORKSPACE_ID,
    name: 'Mock Workspace',
    ownerId: options.workspaceOwner === false ? 'someone-else' : USER_ID,
  }))
}

async function mountView() {
  const { default: ToolFacesView } = await import('../ToolFacesView.vue')
  const wrapper = mount(ToolFacesView, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  vi.mocked(api.listPolicyToolFaces).mockResolvedValue([builtinFace, unclassifiedFace])
})

describe('ToolFacesView', () => {
  it('renders built-in and persisted rows with their source and shape', async () => {
    seedIdentity()
    const wrapper = await mountView()

    expect(api.listPolicyToolFaces).toHaveBeenCalledWith('workspace')
    expect(wrapper.find('[data-testid="settings-tool-face-read_file"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="settings-tool-face-source-read_file"]').text()).toBe('内置')
    expect(wrapper.find('[data-testid="settings-tool-face-shape-read_file"]').text()).toContain('结构化')
    expect(wrapper.find('[data-testid="settings-tool-face-source-mcp__third_party__do"]').text()).toBe('工作区')
  })

  it('highlights unclassified rows with the default ask label', async () => {
    seedIdentity()
    const wrapper = await mountView()

    const highlight = wrapper.find('[data-testid="settings-tool-face-unclassified-mcp__third_party__do"]')
    expect(highlight.text()).toContain('默认 ask')
    expect(highlight.text()).toContain('未分类')
  })

  it('offers classification to workspace owners and saves the explicit choice', async () => {
    seedIdentity({ workspaceOwner: true })
    vi.mocked(api.upsertPolicyToolFace).mockResolvedValue({
      ...unclassifiedFace,
      actionClass: 'exec',
      shape: 'interpreter',
    })
    const wrapper = await mountView()

    await wrapper.find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]').trigger('click')
    expect(wrapper.find('[data-testid="settings-tool-face-classify-form-mcp__third_party__do"]').exists()).toBe(true)

    await wrapper.find('[data-testid="settings-tool-face-classify-action-class-mcp__third_party__do"]').setValue('exec')
    await wrapper.find('[data-testid="settings-tool-face-classify-shape-mcp__third_party__do"]').setValue('interpreter')
    await wrapper.find('[data-testid="settings-tool-face-classify-form-mcp__third_party__do"]').trigger('submit')
    await flushPromises()

    expect(api.upsertPolicyToolFace).toHaveBeenCalledWith({
      scope: 'workspace',
      tool: 'mcp__third_party__do',
      actionClass: 'exec',
      shape: 'interpreter',
    })
    expect(api.listPolicyToolFaces).toHaveBeenLastCalledWith('workspace')
  })

  it('shows classification copy instead of an entry for non-owners', async () => {
    seedIdentity({ workspaceOwner: false })
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-tool-faces-forbidden"]').text()).toContain('OWNER')
    expect(wrapper.find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="settings-tool-face-classify-read_file"]').exists()).toBe(false)
  })

  it('never offers a workspace override for built-in classifications', async () => {
    seedIdentity({ workspaceOwner: true })
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-tool-face-classify-read_file"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]').exists()).toBe(true)
  })

  it('keeps the instance scope for admins and reloads the catalog for that scope', async () => {
    seedIdentity({ admin: true })
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-tool-faces-scope-instance"]').exists()).toBe(true)
    await wrapper.find('[data-testid="settings-tool-faces-scope-instance"]').trigger('click')
    await flushPromises()

    expect(api.listPolicyToolFaces).toHaveBeenLastCalledWith('instance')
  })

  it('surfaces a server 403 from classification without pretending success', async () => {
    seedIdentity({ workspaceOwner: true })
    vi.mocked(api.upsertPolicyToolFace).mockRejectedValue(new ApiError({
      status: 403,
      code: 'FORBIDDEN',
      detail: 'workspace-scope faces require workspace OWNER or ADMIN',
      requestId: 'test',
    }))
    const wrapper = await mountView()

    await wrapper.find('[data-testid="settings-tool-face-classify-mcp__third_party__do"]').trigger('click')
    await wrapper.find('[data-testid="settings-tool-face-classify-action-class-mcp__third_party__do"]').setValue('exec')
    await wrapper.find('[data-testid="settings-tool-face-classify-form-mcp__third_party__do"]').trigger('submit')
    await flushPromises()

    expect(wrapper.find('[data-testid="settings-tool-face-classify-validation-mcp__third_party__do"]').text()).toContain('FORBIDDEN')
    expect(wrapper.find('[data-testid="settings-tool-faces-error"]').text()).toContain('FORBIDDEN')
  })

  it('renders the empty state when the catalog has no rows', async () => {
    seedIdentity()
    vi.mocked(api.listPolicyToolFaces).mockResolvedValue([])
    const wrapper = await mountView()

    expect(wrapper.find('[data-testid="settings-tool-faces-empty"]').exists()).toBe(true)
  })
})
