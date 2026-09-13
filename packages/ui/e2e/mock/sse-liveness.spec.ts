import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

const SESSION_ID = 'liveness-session'

async function installLivenessSSE(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
    const encode = (value: string) => new TextEncoder().encode(value)
    const sse = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
    ;(window as unknown as Record<string, unknown>).__pushLivenessEvent = (name: string, data: unknown) => {
      controllerRef?.enqueue(encode(sse(name, data)))
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
          },
        })
        return new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      if (
        requestUrl.includes('/api/v1/chat') &&
        !requestUrl.includes('/api/v1/chat/') &&
        (init?.method ?? 'GET') === 'POST'
      ) {
        return new Response(JSON.stringify({ status: 'accepted' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return originalFetch(input, init)
    }
  })
}

async function push(page: import('@playwright/test').Page, name: string, data: unknown) {
  await page.evaluate(
    ([eventName, payload]) => {
      ;(window as unknown as Record<string, unknown>).__pushLivenessEvent!(eventName as string, payload)
    },
    [name, data] as const,
  )
}

async function startRun(page: import('@playwright/test').Page) {
  await page.goto(`/chat/${SESSION_ID}`)
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })
  await page.locator('textarea').fill('run a long task')
  await page.locator('textarea').press('Enter')
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible({ timeout: 10000 })
  await push(page, 'token', { content: 'working' })
  await expect(page.locator('text=working')).toBeVisible({ timeout: 10000 })
}

const evidenceDir = resolve(process.cwd(), '../../../.local/plan-0323')

test.describe('SSE liveness timer (S-1)', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install()
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: 'Liveness' }] })
    await installLivenessSSE(page)
  })

  test('heartbeats keep a long silent tool gap alive', async ({ page }) => {
    await startRun(page)

    for (let i = 0; i < 4; i += 1) {
      await page.clock.fastForward(20_000)
      await push(page, 'heartbeat', { type: 'heartbeat' })
    }
    await page.clock.fastForward(20_000)

    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
    await page.screenshot({ path: resolve(evidenceDir, 's1-liveness-heartbeats.png') })
  })

  test('silence after content triggers AGENT_TIMEOUT', async ({ page }) => {
    await startRun(page)

    await page.clock.fastForward(31_000)

    const toast = page.locator('[data-sonner-toast]')
    await expect(toast).toBeVisible({ timeout: 5000 })
    await expect(toast).toContainText('AGENT_TIMEOUT')
    await page.screenshot({ path: resolve(evidenceDir, 's1-liveness-timeout.png') })
  })

  test('silence before the first token also reports AGENT_TIMEOUT', async ({ page }) => {
    await page.goto(`/chat/${SESSION_ID}`)
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })
    await page.locator('textarea').fill('quick question')
    await page.locator('textarea').press('Enter')
    await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible({ timeout: 10000 })

    await page.clock.fastForward(31_000)

    const toast = page.locator('[data-sonner-toast]')
    await expect(toast).toBeVisible({ timeout: 5000 })
    await expect(toast).toContainText('AGENT_TIMEOUT')
  })
})
