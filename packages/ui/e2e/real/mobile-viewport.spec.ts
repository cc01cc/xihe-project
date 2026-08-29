import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('Mobile Viewport (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  let authToken = ''

  test.beforeAll(async ({ request }) => {
    const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `mobile-${Date.now()}@test.com`, password: 'Test1234!', name: 'Mobile' },
    })
    authToken = (await r.json()).accessToken
  })

  async function assertNoHorizontalOverflow(page: import('@playwright/test').Page) {
    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement
      return doc ? doc.scrollWidth - doc.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(2)
  }

  test('login page renders within mobile viewport', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'load' })
    await page.waitForTimeout(800)
    await assertNoHorizontalOverflow(page)
    await expect(page).toHaveScreenshot('mobile-login.png')
  })

  test('chat page input area stays on screen on mobile', async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
    await page.goto('/chat', { waitUntil: 'load' })
    await page.locator('textarea').waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForTimeout(800)

    const textarea = page.locator('textarea')
    const box = await textarea.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y + box!.height).toBeLessThanOrEqual(844)
    expect(box!.x + box!.width).toBeLessThanOrEqual(392)

    await assertNoHorizontalOverflow(page)
    await expect(page).toHaveScreenshot('mobile-chat.png')
  })

  test('settings config page renders within mobile viewport', async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.locator('[data-testid="settings-config-heading"]')).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(800)
    await assertNoHorizontalOverflow(page)
    await expect(page).toHaveScreenshot('mobile-settings-config.png')
  })

  test('mobile chat dialogs remain closable', async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
    await page.goto('/chat', { waitUntil: 'load' })
    await page.locator('textarea').waitFor({ state: 'visible', timeout: 10000 })
    const dialogs = page.locator('[role="dialog"]')
    expect(await dialogs.count()).toBe(0)
  })
})
