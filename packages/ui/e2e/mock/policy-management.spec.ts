import { expect, test, type Page } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

const SESSION_ID = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1'
const WORKSPACE_ID = 'workspace-1'
const RUN_ID = 'd1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const CONFLICT_ID = '22222222-2222-4222-8222-222222222222'
const UNCLASSIFIED_TOOL = 'mcp__third_party__do'

interface PolicyRulePayload {
  id: string
  layer: string
  ownerId: string | null
  actionClass: string
  resource: string
  effect: string
  priority: number
  locked: boolean
  effective: boolean
  conflict: string | null
}

interface PolicyFacePayload {
  id: string | null
  scope: 'builtin' | 'instance' | 'workspace'
  ownerId: string | null
  tool: string
  actionClass: string
  shape: string
}

const conflictedAllow: PolicyRulePayload = {
  id: CONFLICT_ID,
  layer: 'workspace',
  ownerId: WORKSPACE_ID,
  actionClass: 'exec',
  resource: 'pnpm *',
  effect: 'allow',
  priority: 0,
  locked: false,
  effective: true,
  conflict: '该 allow 不会生效：存在更具体的 deny "pnpm test *"',
}

const workspaceDeny: PolicyRulePayload = {
  id: '33333333-3333-4333-8333-333333333333',
  layer: 'workspace',
  ownerId: WORKSPACE_ID,
  actionClass: 'exec',
  resource: 'pnpm test *',
  effect: 'deny',
  priority: 0,
  locked: true,
  effective: true,
  conflict: null,
}

const domainsPayload = [
  { actionClass: 'exec', effectiveLayer: 'workspace', configuredLayers: ['workspace'], ruleCounts: { workspace: 2 } },
  { actionClass: 'read', effectiveLayer: 'builtin', configuredLayers: [], ruleCounts: {} },
]

function installPolicyApi(page: Page) {
  const state = {
    rules: { instance: [] as PolicyRulePayload[], user: [] as PolicyRulePayload[], workspace: [conflictedAllow, workspaceDeny] },
    faces: [
      { id: null, scope: 'builtin', ownerId: null, tool: 'read_file', actionClass: 'read', shape: 'structured' },
      { id: '44444444-4444-4444-8444-444444444444', scope: 'workspace', ownerId: WORKSPACE_ID, tool: UNCLASSIFIED_TOOL, actionClass: 'unclassified', shape: 'opaque' },
    ] as PolicyFacePayload[],
    createdRules: [] as Array<Record<string, unknown>>,
    deletedRules: [] as string[],
    classifications: [] as Array<Record<string, unknown>>,
    conflictsRequested: [] as string[],
  }

  // Registered after setupMockAuth on purpose: Playwright routes are LIFO, so these
  // specific handlers take precedence over the helper's catch-all.
  void page.route('**/api/v1/policy/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const layer = url.searchParams.get('layer') ?? ''
    const scope = url.searchParams.get('scope') ?? 'workspace'
    const json = (status: number, body: unknown) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })

    if (url.pathname.endsWith('/policy/domains') && method === 'GET') {
      return json(200, domainsPayload)
    }
    if (url.pathname.endsWith('/policy/rules/conflicts') && method === 'GET') {
      state.conflictsRequested.push(layer)
      return json(200, state.rules[layer as keyof typeof state.rules]?.filter((rule) => rule.conflict !== null) ?? [])
    }
    if (url.pathname.endsWith('/policy/rules') && method === 'GET') {
      return json(200, state.rules[layer as keyof typeof state.rules] ?? [])
    }
    if (url.pathname.endsWith('/policy/rules') && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.createdRules.push(body)
      const created: PolicyRulePayload = {
        id: `created-${state.createdRules.length}`,
        layer: String(body.layer),
        ownerId: String(body.layer) === 'instance' ? null : WORKSPACE_ID,
        actionClass: String(body.actionClass),
        resource: String(body.resource),
        effect: String(body.effect),
        priority: Number(body.priority ?? 0),
        locked: body.locked === true,
        effective: true,
        conflict: null,
      }
      state.rules[created.layer as keyof typeof state.rules]?.push(created)
      return json(200, created)
    }
    if (url.pathname.includes('/policy/rules/') && method === 'DELETE') {
      const id = url.pathname.split('/').filter(Boolean).at(-1) ?? ''
      state.deletedRules.push(id)
      state.rules[layer as keyof typeof state.rules] = (state.rules[layer as keyof typeof state.rules] ?? [])
        .filter((rule) => rule.id !== id)
      return route.fulfill({ status: 204, body: '' })
    }
    if (url.pathname.endsWith('/policy/tool-faces') && method === 'GET') {
      return json(200, state.faces)
    }
    if (url.pathname.endsWith('/policy/tool-faces') && method === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      state.classifications.push(body)
      const existing = state.faces.find((face) => face.tool === body.tool && face.scope === body.scope)
      if (existing) {
        existing.actionClass = String(body.actionClass)
        existing.shape = String(body.shape)
        return json(200, existing)
      }
      const created = {
        id: '55555555-5555-4555-8555-555555555555',
        scope: String(body.scope) as PolicyFacePayload['scope'],
        ownerId: WORKSPACE_ID,
        tool: String(body.tool),
        actionClass: String(body.actionClass),
        shape: String(body.shape),
      }
      state.faces.push(created)
      return json(200, created)
    }
    return json(404, { code: 'NOT_FOUND', detail: `unmocked ${method} ${url.pathname}`, status: 404 })
  })

  return state
}

async function installApprovalSSE(page: Page) {
  await page.addInitScript(({ sessionId, runId }: { sessionId: string; runId: string }) => {
    const pending: unknown[] = []
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
    const encode = (value: string) => new TextEncoder().encode(value)
    const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    const drain = () => {
      if (!controllerRef) return
      while (pending.length > 0) {
        controllerRef.enqueue(encode(sse('approval_request', pending.shift())))
      }
    }
    ;(window as unknown as Record<string, unknown>).__pushApprovalEvent = (payload: unknown) => {
      pending.push(payload)
      drain()
    }
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : input.url
      if (requestUrl.includes('/api/v1/events')) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller
            controller.enqueue(encode('retry: 1000\n\n'))
            queueMicrotask(drain)
          },
        })
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      if (
        requestUrl.includes('/api/v1/chat') &&
        !requestUrl.includes('/api/v1/chat/approvals/') &&
        (init?.method ?? 'GET') === 'POST'
      ) {
        return new Response(JSON.stringify({ status: 'accepted', sessionId, runId }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }
  }, { sessionId: SESSION_ID, runId: RUN_ID })
}

function unclassifiedApprovalEvent() {
  return {
    requestId: REQUEST_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    tool: UNCLASSIFIED_TOOL,
    action: 'call third-party tool',
    details: 'third-party payload preview',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    state: 'pending',
    replayed: false,
    policy: {
      effect: 'ask',
      sourceLayer: 'builtin',
      matchedRule: null,
      reason: 'unclassified tool requires explicit classification',
      mode: 'manual',
      actionClass: 'unclassified',
      shape: 'opaque',
    },
  }
}

async function pushApproval(page: Page, payload: Record<string, unknown>) {
  await page.evaluate((data) => {
    ;(window as unknown as Record<string, unknown>).__pushApprovalEvent!(data)
  }, payload)
}

function installDecisionRoute(page: Page) {
  const calls: Array<Record<string, unknown>> = []
  void page.route('**/api/v1/chat/approvals/**', async (route) => {
    calls.push((route.request().postDataJSON() as Record<string, unknown>) ?? {})
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'accepted', requestId: REQUEST_ID, approved: true, decision: 'once' }),
    })
  })
  return calls
}

test.describe('Policy management (desktop)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: 'Policy Session' }] })
  })

  test('shows domains with the effective layer, a conflicted rule, and creates plus deletes a rule', async ({ page }) => {
    const state = installPolicyApi(page)
    await page.goto('/settings/policy')

    await expect(page.getByTestId('settings-policy-heading')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('settings-policy-domain-effective-exec')).toContainText('工作区层')
    await expect(page.getByTestId('settings-policy-domain-effective-read')).toContainText('内置层')

    await page.getByTestId('settings-policy-layer-workspace').click()
    const conflictRow = page.getByTestId(`settings-policy-rule-conflict-${CONFLICT_ID}`)
    await expect(conflictRow).toBeVisible()
    await expect(conflictRow).toContainText('更具体的 deny')
    await expect(page.getByTestId('settings-policy-conflict-summary')).toContainText('冲突')
    expect(state.conflictsRequested).toContain('workspace')

    await page.getByTestId('settings-policy-create-action-class').fill('read')
    await page.getByTestId('settings-policy-create-resource').fill('docs/**')
    await page.getByTestId('settings-policy-create-effect').selectOption('allow')
    await page.getByTestId('settings-policy-create-submit').click()
    await expect.poll(() => state.createdRules.length).toBe(1)
    expect(state.createdRules[0]).toEqual({
      layer: 'workspace',
      actionClass: 'read',
      resource: 'docs/**',
      effect: 'allow',
      priority: 0,
      locked: false,
    })
    await expect(page.getByTestId('settings-policy-rule-created-1')).toBeVisible()

    await page.getByTestId(`settings-policy-rule-delete-${CONFLICT_ID}`).click()
    const confirm = page.getByTestId('settings-policy-delete-confirm')
    await expect(confirm).toBeVisible()
    expect(state.deletedRules).toHaveLength(0)
    await confirm.click()
    await expect.poll(() => state.deletedRules).toEqual([CONFLICT_ID])
    await expect(page.getByTestId(`settings-policy-rule-${CONFLICT_ID}`)).toHaveCount(0)
  })

  test('keeps the locked control admin-only with the server reason in copy', async ({ page }) => {
    installPolicyApi(page)
    await page.goto('/settings/policy')
    await expect(page.getByTestId('settings-policy-heading')).toBeVisible()

    await expect(page.getByTestId('settings-policy-layer-instance')).toHaveCount(0)
    await expect(page.getByTestId('settings-policy-create-locked')).toHaveCount(0)
    await expect(page.getByTestId('settings-policy-layer-workspace')).toBeVisible()
  })

  test('offers the locked control to instance admins and shows locked rows read-only', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-user', JSON.stringify({ id: 'user-1', email: 'test@xihe.local', role: 'ADMIN' }))
    })
    installPolicyApi(page)
    await page.goto('/settings/policy')
    await expect(page.getByTestId('settings-policy-heading')).toBeVisible()

    await expect(page.getByTestId('settings-policy-layer-instance')).toBeVisible()
    await expect(page.getByTestId('settings-policy-create-locked')).toBeVisible()
    await page.getByTestId('settings-policy-layer-workspace').click()
    await expect(page.getByTestId(`settings-policy-rule-locked-${workspaceDeny.id}`)).toContainText('已锁定')
  })

  test('lists tool faces, highlights unclassified tools, and classifies as workspace owner', async ({ page }) => {
    const state = installPolicyApi(page)
    await page.goto('/settings/tool-faces')

    await expect(page.getByTestId('settings-tool-faces-heading')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('settings-tool-face-source-read_file')).toContainText('内置')
    await expect(page.getByTestId(`settings-tool-face-unclassified-${UNCLASSIFIED_TOOL}`)).toContainText('默认 ask')
    await expect(page.getByTestId(`settings-tool-face-unclassified-${UNCLASSIFIED_TOOL}`)).toContainText('未分类')

    await page.getByTestId(`settings-tool-face-classify-${UNCLASSIFIED_TOOL}`).click()
    await page.getByTestId(`settings-tool-face-classify-action-class-${UNCLASSIFIED_TOOL}`).fill('exec')
    await page.getByTestId(`settings-tool-face-classify-shape-${UNCLASSIFIED_TOOL}`).selectOption('interpreter')
    await page.getByTestId(`settings-tool-face-classify-submit-${UNCLASSIFIED_TOOL}`).click()

    await expect.poll(() => state.classifications.length).toBe(1)
    expect(state.classifications[0]).toEqual({
      scope: 'workspace',
      tool: UNCLASSIFIED_TOOL,
      actionClass: 'exec',
      shape: 'interpreter',
    })
    await expect(page.getByTestId(`settings-tool-face-action-class-${UNCLASSIFIED_TOOL}`)).toContainText('exec')
    await expect(page.getByTestId(`settings-tool-face-unclassified-${UNCLASSIFIED_TOOL}`)).toHaveCount(0)
  })

  test('approval classify-and-allow classifies first and hands back a once decision', async ({ page }) => {
    const state = installPolicyApi(page)
    await installApprovalSSE(page)
    const calls = installDecisionRoute(page)

    await page.goto(`/chat/${SESSION_ID}`)
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 10000 })
    await pushApproval(page, unclassifiedApprovalEvent())

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator('[data-testid="approval-unclassified-notice"]')).toContainText('未分类')
    // Never a one-click persistent allow for unclassified tools.
    await expect(dialog.locator('[data-testid="approval-allow-session"]')).toHaveCount(0)
    await expect(dialog.locator('[data-testid="approval-save-rule"]')).toHaveCount(0)
    expect(calls).toHaveLength(0)

    await dialog.locator('[data-testid="approval-classify-entry"]').click()
    expect(calls).toHaveLength(0)
    expect(state.classifications).toHaveLength(0)
    await dialog.locator('[data-testid="approval-classify-action-class"]').fill('exec')
    await dialog.locator('[data-testid="approval-classify-shape"]').selectOption('interpreter')
    await dialog.locator('[data-testid="approval-classify-submit"]').click()

    await expect.poll(() => state.classifications.length).toBe(1)
    expect(state.classifications[0]).toEqual({
      scope: 'workspace',
      tool: UNCLASSIFIED_TOOL,
      actionClass: 'exec',
      shape: 'interpreter',
    })
    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0]).toEqual({ decision: 'once' })
  })
})

test.describe('Policy management (mobile)', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: 'Policy Session' }] })
  })

  test('renders rules and unclassified tool faces on a small viewport', async ({ page }) => {
    installPolicyApi(page)
    await page.goto('/settings/policy')

    await expect(page.getByTestId('settings-policy-heading')).toBeVisible({ timeout: 10000 })
    await page.getByTestId('settings-policy-layer-workspace').click()
    await expect(page.getByTestId(`settings-policy-rule-${CONFLICT_ID}`)).toBeVisible()
    await expect(page.getByTestId(`settings-policy-rule-conflict-${CONFLICT_ID}`)).toBeVisible()

    await page.goto('/settings/tool-faces')
    await expect(page.getByTestId('settings-tool-faces-heading')).toBeVisible()
    await expect(page.getByTestId(`settings-tool-face-unclassified-${UNCLASSIFIED_TOOL}`)).toContainText('默认 ask')
  })

  test('classify-and-allow works in the mobile approval sheet', async ({ page }) => {
    const state = installPolicyApi(page)
    await installApprovalSSE(page)
    const calls = installDecisionRoute(page)

    await page.goto(`/chat/${SESSION_ID}`)
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 10000 })
    await pushApproval(page, unclassifiedApprovalEvent())

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('[data-testid="approval-classify-entry"]').click()
    await dialog.locator('[data-testid="approval-classify-action-class"]').fill('exec')
    await dialog.locator('[data-testid="approval-classify-submit"]').click()

    await expect.poll(() => state.classifications.length).toBe(1)
    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0]).toEqual({ decision: 'once' })
  })
})
