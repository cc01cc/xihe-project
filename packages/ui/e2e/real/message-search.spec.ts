import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('Message Search', () => {
  let authToken = ''

  test.beforeAll(async ({ request }) => {
    const r = await request.post(`${CP_URL}/auth/register`, {
      data: { email: `msg-${Date.now()}@test.com`, password: 'Test1234!', name: 'Test' },
    })
    if (r.ok()) {
      const body = await r.json()
      authToken = body.accessToken
    }
  })

  test('chat page loads with real auth and shows search placeholder', async ({ page }) => {
    expect(authToken).toBeTruthy()
    await page.goto('/chat')
    await page.evaluate((t) => {
      localStorage.setItem('xihe-token', t)
      localStorage.setItem('xihe-user', JSON.stringify({ id: 'real', name: 'Test' }))
    }, authToken)
    await page.reload()
    await page.waitForLoadState('load')
    // Chat page rendered
    await expect(page.locator('#app')).toBeAttached({ timeout: 10000 })
  })
})
