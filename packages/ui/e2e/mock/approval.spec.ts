import { test, expect } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SECOND_SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const WORKSPACE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const RUN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'

const approvalEvent = (
  requestId: string,
  replayed = false,
  shape: 'structured' | 'interpreter' | 'opaque' = 'structured',
  actionClass = 'delete',
) => ({
  requestId,
  runId: RUN_ID,
  sessionId: SESSION_ID,
  workspaceId: WORKSPACE_ID,
  tool: 'request_approval',
  action: 'delete file',
  details: 'workspace/README.md',
  snapshotId: null,
  policyClass: 'unknown',
  argumentsHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  state: 'pending',
  replayed,
  policy: {
    effect: 'ask',
    sourceLayer: 'workspace',
    matchedRule: null,
    reason: 'No matching allow rule',
    mode: 'default',
    actionClass,
    shape,
  },
})

async function installApprovalSSE(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ({ sessionId, runId }: { sessionId: string; runId: string }) => {
      const pending: unknown[] = []
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
      const encode = (value: string) => new TextEncoder().encode(value)
      const sse = (name: string, data: unknown) =>
        `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
      const drain = () => {
        if (!controllerRef) return
        while (pending.length > 0) {
          const item = pending.shift()
          controllerRef.enqueue(encode(sse('approval_request', item)))
        }
      }
      ;(window as unknown as Record<string, unknown>).__pushApprovalEvent = (payload: unknown) => {
        pending.push(payload)
        drain()
      }
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const requestUrl =
          typeof input === 'string' ? input : input instanceof Request ? input.url : input.url
        if (requestUrl.includes('/api/v1/events')) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controllerRef = controller
              controller.enqueue(encode('retry: 1000\n\n'))
              queueMicrotask(drain)
            },
          })
          return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
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
      void sessionId
    },
    { sessionId: SESSION_ID, runId: RUN_ID },
  )
}

async function installDecisionRoute(
  page: import('@playwright/test').Page,
  status: number,
  body: Record<string, unknown>,
) {
  const calls: Array<{ requestId: string; body: Record<string, unknown> }> = []
  await page.route('**/api/v1/chat/approvals/**', async (route) => {
    const payload = route.request().postDataJSON() as Record<string, unknown> | null
    const url = new URL(route.request().url())
    calls.push({
      requestId: url.pathname.split('/').filter(Boolean).at(-2) ?? '',
      body: payload ?? {},
    })
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
  return calls
}

async function installPendingRoute(
  page: import('@playwright/test').Page,
  summaries: Array<{ sessionId: string; workspaceId: string; count: number; oldestRequestedAt: string }>,
) {
  await page.route('**/api/v1/approvals/pending', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(summaries),
    })
  })
}

async function installPolicyModeRoute(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/policy/mode*', async (route) => {
    const url = new URL(route.request().url())
    const body = route.request().method() === 'POST'
      ? route.request().postDataJSON() as { sessionId?: string } | null
      : null
    const sessionId = body?.sessionId ?? url.searchParams.get('sessionId') ?? SESSION_ID
    const isPost = route.request().method() === 'POST'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(isPost
        ? { sessionId, mode: 'default', scope: 'session' }
        : { sessionId, mode: 'default', sessionRules: 0 }),
    })
  })
}

async function openApprovalChat(page: import('@playwright/test').Page) {
  await page.goto(`/chat/${SESSION_ID}`)
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 10000 })
}

async function pushApproval(page: import('@playwright/test').Page, payload: Record<string, unknown>) {
  await page.evaluate((data) => {
    ;(window as unknown as Record<string, unknown>).__pushApprovalEvent!(data)
  }, payload)
}

test.describe('Chat approval flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [
      { id: SESSION_ID, title: 'Approval Flow' },
      { id: SECOND_SESSION_ID, title: 'Second Session' },
    ] })
    await installPolicyModeRoute(page)
    await installApprovalSSE(page)
  })

  test('renders approval modal from canonical approval_request event', async ({ page }) => {
    await openApprovalChat(page)

    await pushApproval(page, approvalEvent(REQUEST_ID))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator('text=delete file')).toBeVisible()
    await expect(dialog.locator('text=workspace/README.md')).toBeVisible()
    await expect(dialog.locator('[data-testid="approval-evidence-action-class"]')).toHaveText('delete')
    await expect(dialog.locator('[data-testid="approval-evidence-shape"]')).toHaveText('结构化')
    await expect(dialog.locator('[data-testid="approval-approve"]')).toBeEnabled()
    await expect(dialog.locator('[data-testid="approval-approve"]')).toBeFocused()
    await expect(dialog.locator('[data-testid="approval-reject"]')).toBeEnabled()
    await expect(page).toHaveScreenshot('approval-modal-request.png')
  })

  test('delete-shaped approvals offer only once and explain the narrowed ceiling', async ({ page }) => {
    await openApprovalChat(page)
    await pushApproval(page, approvalEvent(REQUEST_ID))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator('[data-testid="approval-approve"]')).toBeEnabled()
    // CP ReusePolicy.allowedTiers: structured+delete is once-only, so no reuse tier is offered.
    await expect(dialog.locator('[data-testid="approval-allow-session"]')).toHaveCount(0)
    await expect(dialog.locator('[data-testid="approval-save-rule"]')).toHaveCount(0)
    await expect(dialog.locator('[data-testid="approval-tier-gate-reason"]')).toContainText('删除类动作')
  })

  test('legacy approvals without a policy projection offer only once with the evidence explanation', async ({ page }) => {
    await openApprovalChat(page)
    const legacyEvent = approvalEvent(REQUEST_ID) as Record<string, unknown>
    delete legacyEvent.policy
    await pushApproval(page, legacyEvent)

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator('[data-testid="approval-approve"]')).toBeEnabled()
    // Absent shape evidence cannot derive a reuse ceiling, so only the once tier is offered.
    await expect(dialog.locator('[data-testid="approval-allow-session"]')).toHaveCount(0)
    await expect(dialog.locator('[data-testid="approval-save-rule"]')).toHaveCount(0)
    await expect(dialog.locator('[data-testid="approval-tier-gate-reason"]')).toContainText('工具形态依据不可用')
  })

  test('renders dispatch_unknown recovery as an explicit retry without auto-deciding', async ({ page }) => {
    const calls = await installDecisionRoute(page, 200, {
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
      decision: 'once',
    })
    await openApprovalChat(page)

    await pushApproval(page, { ...approvalEvent(REQUEST_ID), state: 'dispatch_unknown' })

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator('[data-testid="approval-retry-warning"]')).toContainText('retry')
    expect(calls).toHaveLength(0)

    await dialog.locator('[data-testid="approval-approve"]').click()
    await expect(dialog).toBeHidden({ timeout: 5000 })
    expect(calls).toEqual([{ requestId: REQUEST_ID, body: { decision: 'once' } }])
  })

  test('approve once submits a structured decision and closes modal', async ({ page }) => {
    const calls = await installDecisionRoute(page, 200, {
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
      decision: 'once',
    })
    await openApprovalChat(page)
    await pushApproval(page, approvalEvent(REQUEST_ID))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('[data-testid="approval-approve"]').click()

    await expect(dialog).toBeHidden({ timeout: 5000 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ requestId: REQUEST_ID, body: { decision: 'once' } })
  })

  test('reject submits optional feedback and sends no further decision', async ({ page }) => {
    const calls = await installDecisionRoute(page, 200, {
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: false,
      decision: 'reject',
    })
    await openApprovalChat(page)
    await pushApproval(page, approvalEvent(REQUEST_ID))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('[data-testid="approval-feedback"]').fill('Not within this task')
    await dialog.locator('[data-testid="approval-reject"]').click()

    await expect(dialog).toBeHidden({ timeout: 5000 })
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ decision: 'reject', feedback: 'Not within this task' })
  })

  test('session approval submits the session-scoped decision', async ({ page }) => {
    const calls = await installDecisionRoute(page, 200, {
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
      decision: 'session',
    })
    await openApprovalChat(page)
    await pushApproval(page, approvalEvent(REQUEST_ID, false, 'structured', 'write'))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('[data-testid="approval-allow-session"]').click()

    await expect(dialog).toBeHidden({ timeout: 5000 })
    expect(calls).toEqual([{ requestId: REQUEST_ID, body: { decision: 'session' } }])
  })

  test('saved approval requires an in-modal confirmation and sends the selected rule scope', async ({ page }) => {
    const calls = await installDecisionRoute(page, 200, {
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
      decision: 'saved',
      rule: { layer: 'user', actionClass: 'delete', resource: 'workspace/**', effect: 'allow' },
    })
    await openApprovalChat(page)
    await pushApproval(page, approvalEvent(REQUEST_ID, false, 'structured', 'write'))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('[data-testid="approval-save-rule"]').click()
    await expect(dialog.locator('[data-testid="approval-save-confirm"]')).toBeVisible()
    await expect(page.locator('[data-testid="modal-content"]')).toHaveCount(1)
    await expect(dialog.locator('[data-testid="approval-save-confirm-button"]')).toBeDisabled()
    await dialog.locator('[data-testid="approval-save-back"]').click()
    await expect(dialog.locator('[data-testid="approval-save-rule"]')).toBeFocused()
    await dialog.locator('[data-testid="approval-save-rule"]').click()
    await dialog.locator('[data-testid="approval-rule-layer"]').selectOption('user')
    await dialog.locator('[data-testid="approval-rule-resource"]').fill('workspace/**')
    await expect(dialog.locator('[data-testid="approval-rule-preview"]')).toContainText('workspace/**')
    await expect(dialog.locator('[data-testid="approval-save-confirm-button"]')).toBeEnabled()
    await expect(dialog.locator('[data-testid="approval-rule-preflight"]')).toContainText('预检不可用')
    await dialog.locator('[data-testid="approval-save-confirm-button"]').click()

    await expect(dialog).toBeHidden({ timeout: 5000 })
    expect(calls).toEqual([{
      requestId: REQUEST_ID,
      body: { decision: 'saved', layer: 'user', rule: { resource: 'workspace/**' } },
    }])
  })

  test('does not offer persistent rules for interpreter-shaped approvals', async ({ page }) => {
    await openApprovalChat(page)
    await pushApproval(page, approvalEvent(REQUEST_ID, false, 'interpreter', 'exec'))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator('[data-testid="approval-save-rule"]')).toHaveCount(0)
    // Interpreter keeps the session tier, so the reason line explains only the saved-rule ceiling.
    await expect(dialog.locator('[data-testid="approval-allow-session"]')).toBeEnabled()
    await expect(dialog.locator('[data-testid="approval-tier-gate-reason"]')).toContainText('解释器形态')
    await expect(dialog.locator('[data-testid="approval-shape-warning"]')).toContainText('解释器')
  })

  test('requires explicit confirmation before saving an all-resources rule', async ({ page }) => {
    const calls = await installDecisionRoute(page, 200, {
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
      decision: 'saved',
    })
    await openApprovalChat(page)
    await pushApproval(page, approvalEvent(REQUEST_ID, false, 'structured', 'write'))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('[data-testid="approval-save-rule"]').click()
    await dialog.locator('[data-testid="approval-rule-resource"]').fill('*')
    await expect(dialog.locator('[data-testid="approval-rule-wildcard-confirm"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="approval-save-confirm-button"]')).toBeDisabled()
    await dialog.locator('[data-testid="approval-rule-wildcard-confirm"]').check()
    await dialog.locator('[data-testid="approval-save-confirm-button"]').click()

    expect(calls[0]?.body).toEqual({ decision: 'saved', layer: 'workspace', rule: { resource: '*' } })
  })

  test('pending summary shows a cross-session banner and navigates to the first session', async ({ page }) => {
    await installPendingRoute(page, [{
      sessionId: SECOND_SESSION_ID,
      workspaceId: WORKSPACE_ID,
      count: 2,
      oldestRequestedAt: new Date().toISOString(),
    }])
    await openApprovalChat(page)

    const banner = page.locator('[data-testid="global-pending-approval-banner"]')
    await expect(banner).toBeVisible({ timeout: 5000 })
    await expect(banner).toContainText('2')
    await banner.locator('[data-testid="global-pending-approval-go-to"]').click()

    await expect(page).toHaveURL(new RegExp(`/chat/${SECOND_SESSION_ID}$`))
  })

  test('shows bypass mode warning and closes it through the mode control', async ({ page }) => {
    await page.unroute('**/api/v1/policy/mode*')
    let mode: 'bypass' | 'default' = 'bypass'
    let postResponse: Record<string, unknown> | null = null
    await page.route('**/api/v1/policy/mode*', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { mode?: string } | null
        if (body?.mode === 'default') mode = 'default'
        postResponse = { sessionId: SESSION_ID, mode, scope: 'session' }
      }
      const response = route.request().method() === 'POST'
        ? postResponse
        : { sessionId: SESSION_ID, mode, sessionRules: 0 }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(response),
      })
    })
    await openApprovalChat(page)

    await expect(page.locator('[data-testid="session-policy-mode-badge"]')).toContainText('免批')
    const bypassBanner = page.locator('[data-testid="session-policy-bypass-banner"]')
    await expect(bypassBanner).toBeVisible()
    await bypassBanner.locator('[data-testid="session-policy-bypass-close"]').click()
    await expect(bypassBanner).toBeHidden()
    await expect(page.locator('[data-testid="session-policy-mode"]')).toHaveValue('default')
    expect(postResponse).toEqual({ sessionId: SESSION_ID, mode: 'default', scope: 'session' })
  })

  test('busy guard prevents duplicate submissions', async ({ page }) => {
    const calls: Array<Record<string, unknown>> = []
    await page.route('**/api/v1/chat/approvals/**', async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown> | null
      calls.push(payload ?? {})
      await page.waitForTimeout(400)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'accepted', requestId: REQUEST_ID, approved: true }),
      })
    })
    await openApprovalChat(page)

    await pushApproval(page, approvalEvent(REQUEST_ID))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    const approveButton = dialog.locator('[data-testid="approval-approve"]')
    await approveButton.click()
    await expect(approveButton).toBeDisabled()
    await expect(dialog).toBeHidden({ timeout: 5000 })
    expect(calls).toEqual([{ decision: 'once' }])
  })

  test('expired decision shows visible error without closing modal', async ({ page }) => {
    await installDecisionRoute(page, 410, {
      code: 'APPROVAL_EXPIRED',
      detail: 'Approval request expired',
      status: 410,
      requestId: REQUEST_ID,
    })
    await openApprovalChat(page)

    await pushApproval(page, approvalEvent(REQUEST_ID))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('[data-testid="approval-approve"]').click()

    await expect(dialog.locator('[data-testid="approval-error"]')).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator('[data-testid="approval-error"]')).toContainText('APPROVAL_EXPIRED')
    await expect(dialog.locator('[data-testid="approval-approve"]')).toBeEnabled()
    await expect(page).toHaveScreenshot('approval-modal-expired.png')
  })

  test('late replay after a local decision does not restore the modal', async ({ page }) => {
    await installDecisionRoute(page, 200, {
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
    })
    await openApprovalChat(page)


    await pushApproval(page, approvalEvent(REQUEST_ID))
    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('[data-testid="approval-approve"]').click()
    await expect(dialog).toBeHidden({ timeout: 5000 })

    await pushApproval(page, approvalEvent(REQUEST_ID, true))
    await expect(dialog).toBeHidden({ timeout: 5000 })
  })

  test('Escape submits one structured rejection', async ({ page }) => {
    const calls = await installDecisionRoute(page, 200, {
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: true,
    })
    await openApprovalChat(page)

    await pushApproval(page, approvalEvent(REQUEST_ID))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 5000 })
    expect(calls).toEqual([{ requestId: REQUEST_ID, body: { decision: 'reject' } }])
  })

  test('workspace chat keeps the bypass warning and close action visible', async ({ page }) => {
    await page.unroute('**/api/v1/policy/mode*')
    await page.route('**/api/v1/policy/mode*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessionId: SESSION_ID, mode: 'bypass', sessionRules: 0 }),
      })
    })

    await page.goto(`/workspace/${WORKSPACE_ID}`)
    if ((await page.locator('[aria-label="Open chat"]:visible').count()) > 0) {
      await page.locator('[aria-label="Open chat"]:visible').click()
    }
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 10000 })
    const banner = page.locator('[data-testid="session-policy-bypass-banner"]:visible')
    await expect(banner).toBeVisible({ timeout: 5000 })
    await expect(banner.locator('[data-testid="session-policy-bypass-close"]')).toBeVisible()
  })

  test('switching away from an awaiting session cannot expose or cancel its run', async ({ page }) => {
    const cancelCalls: string[] = []
    await page.route('**/api/v1/chat/runs/**/cancel', async (route) => {
      cancelCalls.push(route.request().url())
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'cancelled' }) })
    })
    await openApprovalChat(page)
    await page.locator('[data-testid="chat-input"]').fill('run in session A')
    await page.locator('[data-testid="chat-send-button"]').click()
    await expect(page.locator('[data-testid="chat-stop-button"]')).toBeVisible({ timeout: 5000 })
    await pushApproval(page, approvalEvent(REQUEST_ID))
    await page.goto(`/chat/${SECOND_SESSION_ID}`)
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="chat-stop-button"]')).toBeHidden()
    expect(cancelCalls).toHaveLength(0)
  })
})
