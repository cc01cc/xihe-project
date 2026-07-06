import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('Chat — Real Backend', () => {
  let authToken = ''

  test.beforeAll(async ({ request }) => {
    const r = await request.post(`${CP_URL}/auth/register`, {
      data: { email: `real-chat-${Date.now()}@test.com`, password: 'Test1234!', name: 'ChatTest' },
    })
    if (r.ok()) {
      const body = await r.json()
      authToken = body.accessToken
    }
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((t) => {
      localStorage.setItem('xihe-token', t)
    }, authToken)
    await page.goto('/chat', { waitUntil: 'load' })
    await page.locator('textarea').waitFor({ state: 'visible', timeout: 10000 })
  })

  test('chat page renders with sidebar and input area', async ({ page }) => {
    await expect(page.locator('textarea')).toBeVisible({ timeout: 8000 })
    await expect(page).toHaveScreenshot('real-chat-page.png')
  })

  test('creates new session and shows in sidebar', async ({ page }) => {
    const sidebar = page.locator('aside').first()
    await expect(sidebar).toBeVisible({ timeout: 8000 })
    // New session button
    const newBtn = page.locator('button').filter({ hasText: /new|新建/i }).first()
    if (await newBtn.count() > 0) {
      await newBtn.click()
      await page.waitForTimeout(500)
      await expect(page).toHaveScreenshot('real-chat-new-session.png')
    }
  })
})
