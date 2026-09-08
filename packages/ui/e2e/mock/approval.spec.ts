import { test, expect } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

const SESSION_ID = 'approval-session'
const REQUEST_ID = 'req-approval-1'

const approvalEvent = (requestId: string, replayed = false) => ({
  requestId,
  runId: 'run-approval-1',
  sessionId: SESSION_ID,
  workspaceId: 'workspace-1',
  tool: 'request_approval',
  action: 'delete file',
  details: 'workspace/README.md',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  ...(replayed ? { replayed: true } : {}),
})

async function installApprovalSSE(page: import('@playwright/test').Page) {
  await page.addInitScript(
    ({ sessionId }: { sessionId: string }) => {
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
          return new Response(JSON.stringify({ status: 'accepted' }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        return originalFetch(input, init)
      }
      void sessionId
    },
    { sessionId: SESSION_ID },
  )
}

async function installDecisionRoute(
  page: import('@playwright/test').Page,
  status: number,
  body: Record<string, unknown>,
) {
  const calls: Array<{ requestId: string; approved: boolean }> = []
  await page.route('**/api/v1/chat/approvals/**', async (route) => {
    const payload = route.request().postDataJSON() as { approved?: boolean } | null
    const url = new URL(route.request().url())
    calls.push({
      requestId: url.pathname.split('/').filter(Boolean).at(-2) ?? '',
      approved: payload?.approved === true,
    })
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
  return calls
}

async function openApprovalChat(page: import('@playwright/test').Page) {
  await page.goto(`/chat/${SESSION_ID}`)
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })
}

async function pushApproval(page: import('@playwright/test').Page, payload: Record<string, unknown>) {
  await page.evaluate((data) => {
    ;(window as unknown as Record<string, unknown>).__pushApprovalEvent!(data)
  }, payload)
}

test.describe('Chat approval flow', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: 'Approval Flow' }] })
    await installApprovalSSE(page)
  })

  test('renders approval modal from canonical approval_request event', async ({ page }) => {
    await openApprovalChat(page)

    await pushApproval(page, approvalEvent(REQUEST_ID))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator('text=delete file')).toBeVisible()
    await expect(dialog.locator('text=workspace/README.md')).toBeVisible()
    await expect(dialog.locator('[data-testid="approval-approve"]')).toBeEnabled()
    await expect(dialog.locator('[data-testid="approval-reject"]')).toBeEnabled()
    await expect(page).toHaveScreenshot('approval-modal-request.png')
  })

  test('approve submits decision and closes modal', async ({ page }) => {
    const calls = await installDecisionRoute(page, 200, {
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
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ requestId: REQUEST_ID, approved: true })
  })

  test('reject shows terminal error and sends no further decision', async ({ page }) => {
    const calls = await installDecisionRoute(page, 200, {
      status: 'accepted',
      requestId: REQUEST_ID,
      approved: false,
    })
    await openApprovalChat(page)
    await pushApproval(page, approvalEvent(REQUEST_ID))

    const dialog = page.locator('[data-testid="modal-content"]')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('[data-testid="approval-reject"]').click()

    await expect(dialog).toBeHidden({ timeout: 5000 })
    expect(calls).toHaveLength(1)
    expect(calls[0].approved).toBe(false)
  })

  test('busy guard prevents duplicate submissions', async ({ page }) => {
    const calls: boolean[] = []
    await page.route('**/api/v1/chat/approvals/**', async (route) => {
      const payload = route.request().postDataJSON() as { approved?: boolean } | null
      calls.push(payload?.approved === true)
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
    expect(calls).toHaveLength(1)
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

  test('replayed approval request restores the modal', async ({ page }) => {
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
    await expect(dialog).toBeVisible({ timeout: 5000 })
  })

  test('dismiss closes modal without submitting a decision', async ({ page }) => {
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
    expect(calls).toHaveLength(0)
  })
})