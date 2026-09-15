import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ApiError, api } from '../../composables/api'
import { usePolicyAdminStore } from '../policyAdmin'
import type { PolicyRuleView, PolicyToolFaceView } from '../../types'

const RULE_ID = '77777777-7777-4777-8777-777777777777'
const FACE_ID = '88888888-8888-4888-8888-888888888888'
const WORKSPACE_ID = 'workspace-1'

vi.mock('../../composables/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      listPolicyDomains: vi.fn(),
      listPolicyRules: vi.fn(),
      listPolicyRuleConflicts: vi.fn(),
      createPolicyRule: vi.fn(),
      deletePolicyRule: vi.fn(),
      listPolicyToolFaces: vi.fn(),
      upsertPolicyToolFace: vi.fn(),
    },
  }
})

const rule: PolicyRuleView = {
  id: RULE_ID,
  layer: 'workspace',
  ownerId: WORKSPACE_ID,
  actionClass: 'exec',
  resource: 'pnpm *',
  effect: 'allow',
  priority: 0,
  locked: false,
  effective: true,
  conflict: null,
}

const face: PolicyToolFaceView = {
  id: null,
  scope: 'builtin',
  ownerId: null,
  tool: 'read_file',
  actionClass: 'read',
  shape: 'structured',
}

function forbidden(detail: string): ApiError {
  return new ApiError({ status: 403, code: 'FORBIDDEN', detail, requestId: 'test' })
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  vi.mocked(api.listPolicyDomains).mockResolvedValue([])
  vi.mocked(api.listPolicyRules).mockResolvedValue([])
  vi.mocked(api.listPolicyRuleConflicts).mockResolvedValue([])
  vi.mocked(api.listPolicyToolFaces).mockResolvedValue([])
})

describe('usePolicyAdminStore', () => {
  it('loads domains with their effective layers', async () => {
    vi.mocked(api.listPolicyDomains).mockResolvedValue([
      { actionClass: 'exec', effectiveLayer: 'workspace', configuredLayers: ['workspace'], ruleCounts: { workspace: 1 } },
    ])
    const store = usePolicyAdminStore()

    await store.loadDomains()

    expect(store.domains).toHaveLength(1)
    expect(store.domains[0]?.effectiveLayer).toBe('workspace')
    expect(store.domainsError).toBeNull()
  })

  it('records a domain load failure without throwing at the caller', async () => {
    vi.mocked(api.listPolicyDomains).mockRejectedValue(new Error('backend down'))
    const store = usePolicyAdminStore()

    await store.loadDomains()

    expect(store.domainsError).toContain('backend down')
  })

  it('marks a layer as forbidden when the server rejects the authenticated user', async () => {
    vi.mocked(api.listPolicyRules).mockRejectedValue(forbidden('workspace-layer rules require workspace OWNER or ADMIN'))
    const store = usePolicyAdminStore()

    await store.loadRules('workspace')

    expect(store.rulesForbidden.workspace).toBe(true)
    expect(store.rulesError.workspace).toContain('FORBIDDEN')
  })

  it('creates a rule and refreshes the layer, conflicts and domains', async () => {
    vi.mocked(api.createPolicyRule).mockResolvedValue(rule)
    const store = usePolicyAdminStore()

    const created = await store.createRule({
      layer: 'workspace',
      actionClass: 'exec',
      resource: 'pnpm *',
      effect: 'allow',
      priority: 0,
      locked: false,
    })

    expect(created).toEqual(rule)
    expect(api.createPolicyRule).toHaveBeenCalledWith({
      layer: 'workspace',
      actionClass: 'exec',
      resource: 'pnpm *',
      effect: 'allow',
      priority: 0,
      locked: false,
    })
    expect(api.listPolicyRules).toHaveBeenCalledWith('workspace')
    expect(api.listPolicyRuleConflicts).toHaveBeenCalledWith('workspace')
    expect(api.listPolicyDomains).toHaveBeenCalledTimes(1)
    expect(store.rulesError.workspace).toBeNull()
  })

  it('surfaces a create failure through the thrown error and keeps the forbidden flag for 403', async () => {
    vi.mocked(api.createPolicyRule).mockRejectedValue(forbidden('locked rules require ADMIN'))
    const store = usePolicyAdminStore()

    await expect(store.createRule({
      layer: 'instance',
      actionClass: 'exec',
      resource: '*',
      effect: 'ask',
      priority: 0,
      locked: true,
    })).rejects.toThrow()

    expect(store.rulesForbidden.instance).toBe(true)
    expect(store.rulesError.instance).toBeNull()
  })

  it('deletes a rule and refreshes its layer', async () => {
    vi.mocked(api.deletePolicyRule).mockResolvedValue(undefined)
    const store = usePolicyAdminStore()

    await store.deleteRule(RULE_ID, 'workspace')

    expect(api.deletePolicyRule).toHaveBeenCalledWith(RULE_ID, 'workspace')
    expect(api.listPolicyRules).toHaveBeenCalledWith('workspace')
    expect(store.deletingRuleId).toBeNull()
  })

  it('classifies a tool and reloads the effective catalog for the scope', async () => {
    vi.mocked(api.upsertPolicyToolFace).mockResolvedValue({
      ...face,
      id: FACE_ID,
      scope: 'workspace',
      ownerId: WORKSPACE_ID,
      actionClass: 'exec',
      shape: 'interpreter',
    })
    const store = usePolicyAdminStore()

    const result = await store.classifyTool({
      scope: 'workspace',
      tool: 'mcp_tool',
      actionClass: 'exec',
      shape: 'interpreter',
    })

    expect(result.actionClass).toBe('exec')
    expect(api.upsertPolicyToolFace).toHaveBeenCalledWith({
      scope: 'workspace',
      tool: 'mcp_tool',
      actionClass: 'exec',
      shape: 'interpreter',
    })
    expect(api.listPolicyToolFaces).toHaveBeenCalledWith('workspace')
    expect(store.toolFacesScope).toBe('workspace')
  })

  it('records a forbidden classification without retrying silently', async () => {
    vi.mocked(api.upsertPolicyToolFace).mockRejectedValue(forbidden('built-in face cannot be overridden'))
    const store = usePolicyAdminStore()

    await expect(store.classifyTool({
      scope: 'workspace',
      tool: 'execute_command',
      actionClass: 'read',
      shape: 'structured',
    })).rejects.toThrow()

    expect(store.toolFacesForbidden).toBe(true)
    expect(store.toolFacesError).toContain('FORBIDDEN')
  })

  it('marks the conflict summary unavailable instead of reporting none', async () => {
    vi.mocked(api.listPolicyRuleConflicts).mockRejectedValue(new Error('conflict endpoint down'))
    const store = usePolicyAdminStore()

    await store.loadConflicts('workspace')

    expect(store.conflictsByLayer.workspace).toEqual([])
    expect(store.conflictsError.workspace).toContain('conflict endpoint down')
  })

  it('resets catalog state between identity switches', async () => {
    vi.mocked(api.listPolicyToolFaces).mockResolvedValue([face])
    const store = usePolicyAdminStore()
    await store.loadToolFaces('instance')
    expect(store.toolFaces).toHaveLength(1)

    store.reset()

    expect(store.toolFaces).toHaveLength(0)
    expect(store.domains).toHaveLength(0)
    expect(store.toolFacesError).toBeNull()
  })
})
