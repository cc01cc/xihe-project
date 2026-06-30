import { test, expect } from '@playwright/test'

interface Route {
  path: string
  name: string
  requiresAuth: boolean
}

const allRoutes: Route[] = [
  { path: '/login', name: 'login', requiresAuth: false },
  { path: '/register', name: 'register', requiresAuth: false },
  { path: '/chat', name: 'chat-default', requiresAuth: true },
  { path: '/chat/test-session', name: 'chat-session', requiresAuth: true },
  { path: '/settings/model', name: 'settings-model', requiresAuth: true },
  { path: '/settings/theme', name: 'settings-theme', requiresAuth: true },
  { path: '/settings/mcp', name: 'settings-mcp', requiresAuth: true },
  { path: '/settings/knowledge', name: 'settings-knowledge', requiresAuth: true },
  { path: '/settings/data', name: 'settings-data', requiresAuth: true },
  { path: '/workspace', name: 'workspace', requiresAuth: true },
]

for (const route of allRoutes) {
  test(`${route.name} renders with 0 console errors`, async ({ page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })
    page.on('pageerror', (err) => errors.push(err.message))

    if (route.requiresAuth) {
      await page.addInitScript(() => {
        localStorage.setItem('xihe-token', 'mock-token-for-screenshot')
      })
    }

    if (route.path === '/chat/test-session') {
      await page.addInitScript(() => {
        localStorage.setItem('xihe-sessions', JSON.stringify([
          { id: 'test-session', title: 'Test Session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ]))
      })
    }

    await page.route('**/api/v1/events**', async (route2) => {
      await route2.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('retry: 5000\n\n'))
          },
        }),
      })
    })

    await page.route('**/api/v1/exec', async (route2) => {
      await route2.fulfill({ status: 200, body: 'OK' })
    })

    await page.route('**/api/v1/**', async (route2) => {
      await route2.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      })
    })

    const resp = await page.goto(route.path, { waitUntil: 'networkidle', timeout: 15000 })
    expect(resp?.status()).toBe(200)
    await page.waitForTimeout(1000)
    expect(errors).toEqual([])

    await expect(page).toHaveScreenshot(route.name + '.png')
  })
}
