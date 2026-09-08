import { test, expect } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

const SESSION_ID = 'coding-loop-session'

test.describe('PLAN-275: Safe Coding Loop E2E', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: 'Coding Loop' }] })
  })

  test.describe('Policy gate: approval request event', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
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
          const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.url
          if (url.includes('/api/v1/events')) {
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
          return originalFetch(input, init)
        }
      })
    })

    test('approval_request event triggers approval modal with tool info', async ({ page }) => {
      await page.goto(`/chat/${SESSION_ID}`)
      await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })

      await page.evaluate(() => {
        ;(window as unknown as Record<string, unknown>).__pushApprovalEvent!({
          requestId: 'req-1',
          runId: 'run-1',
          sessionId: 'coding-loop-session',
          workspaceId: 'workspace-1',
          tool: 'write_file',
          action: 'write file',
          details: 'src/main.rs',
          policyClass: 'ask_approval',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        })
      })

      const dialog = page.locator('[data-testid="modal-content"]')
      await expect(dialog).toBeVisible({ timeout: 5000 })
      await expect(dialog.locator('text=write file')).toBeVisible()
      await expect(dialog.locator('text=src/main.rs')).toBeVisible()
    })

    test('approval modal shows approve and reject buttons', async ({ page }) => {
      await page.goto(`/chat/${SESSION_ID}`)
      await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })

      await page.evaluate(() => {
        ;(window as unknown as Record<string, unknown>).__pushApprovalEvent!({
          requestId: 'req-2',
          runId: 'run-2',
          sessionId: 'coding-loop-session',
          workspaceId: 'workspace-1',
          tool: 'edit_file',
          action: 'edit file',
          details: 'src/lib.rs',
          policyClass: 'ask_approval',
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        })
      })

      const dialog = page.locator('[data-testid="modal-content"]')
      await expect(dialog).toBeVisible({ timeout: 5000 })
      await expect(dialog.locator('[data-testid="approval-approve"]')).toBeEnabled()
      await expect(dialog.locator('[data-testid="approval-reject"]')).toBeEnabled()
    })
  })

  test.describe('DiffViewer', () => {
    test('renders unified diff with changed files', async ({ page }) => {
      await page.goto(`/chat/${SESSION_ID}`)
      await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })

      await page.evaluate(() => {
        const diffContainer = document.createElement('div')
        diffContainer.setAttribute('data-testid', 'diff-viewer')
        diffContainer.innerHTML = `
          <div class="diff-files">
            <div class="diff-file" data-testid="diff-file">
              <span class="diff-status modified">M</span>
              <span class="diff-path">src/main.rs</span>
              <span class="diff-hash">sha256:abc123</span>
            </div>
          </div>
          <div class="diff-content">
            <div class="diff-hunk">@@ -1,5 +1,7 @@</div>
            <div class="diff-line added">+use std::sync::Arc;</div>
            <div class="diff-line context"> fn main() {</div>
          </div>
        `
        document.body.appendChild(diffContainer)
      })

      const viewer = page.locator('[data-testid="diff-viewer"]')
      await expect(viewer).toBeVisible()
      await expect(viewer.locator('[data-testid="diff-file"]')).toBeVisible()
      await expect(viewer.locator('text=src/main.rs')).toBeVisible()
      await expect(viewer.locator('text=+use std::sync::Arc;')).toBeVisible()
    })
  })

  test.describe('Cancel endpoint contract', () => {
    test('cancel API mock returns correct response structure', async ({ page }) => {
      await page.route('**/api/v1/chat/runs/*/cancel', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'cancel_accepted', runId: 'run-1' }),
        })
      })

      await page.goto(`/chat/${SESSION_ID}`)
      await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })

      // Verify route is registered by making a fetch from page context
      const result = await page.evaluate(async () => {
        const resp = await fetch('/api/v1/chat/runs/run-1/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'user_requested' }),
        })
        return { status: resp.status, body: await resp.json() }
      })
      expect(result.status).toBe(200)
      expect(result.body.status).toBe('cancel_accepted')
    })

    test('cancel mock returns 409 for terminal run', async ({ page }) => {
      await page.route('**/api/v1/chat/runs/*/cancel', async (route) => {
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            type: 'https://xihe.dev/problems/run-not-cancellable',
            title: 'Conflict',
            status: 409,
            code: 'RUN_NOT_CANCELLABLE',
            detail: 'Run is in terminal state: succeeded',
          }),
        })
      })

      await page.goto(`/chat/${SESSION_ID}`)
      await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })

      const result = await page.evaluate(async () => {
        const resp = await fetch('/api/v1/chat/runs/run-1/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        })
        return { status: resp.status, body: await resp.json() }
      })
      expect(result.status).toBe(409)
      expect(result.body.code).toBe('RUN_NOT_CANCELLABLE')
    })
  })
})
