import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

interface Route {
  path: string
  name: string
  requiresAuth: boolean
}

const allRoutes: Route[] = [
  { path: '/login', name: 'real-login', requiresAuth: false },
  { path: '/register', name: 'real-register', requiresAuth: false },
  { path: '/chat', name: 'real-chat-default', requiresAuth: true },
  { path: '/chat/test-session', name: 'real-chat-session', requiresAuth: true },
  { path: '/settings/config', name: 'real-settings-config', requiresAuth: true },
  { path: '/settings/knowledge', name: 'real-settings-knowledge', requiresAuth: true },
  { path: '/settings/data', name: 'real-settings-data', requiresAuth: true },
  { path: '/settings/monitoring', name: 'real-settings-monitoring', requiresAuth: true },
  { path: '/workspace', name: 'real-workspace', requiresAuth: true },
]

for (const route of allRoutes) {
  test(`${route.name} renders and captures screenshot`, async ({ page }) => {
    if (route.requiresAuth) {
      const email = `screenshot-${Date.now()}@test.com`
      const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Test1234!', name: 'Screenshot' }),
      })
      if (reg.ok) {
        const body = await reg.json()
        await page.addInitScript((token: string) => {
          localStorage.setItem('xihe-token', token)
        }, body.accessToken)
      }
    }

    const resp = await page.goto(route.path, { waitUntil: 'load', timeout: 15000 })
    expect(resp?.status()).toBe(200)
    await page.waitForTimeout(1000)

    await expect(page).toHaveScreenshot(route.name + '.png')
  })
}
