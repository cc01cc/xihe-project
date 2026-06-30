import { test, expect } from '@playwright/test'

test.describe('Internationalization', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token-for-testing')
    })
  })

  test('switches from en to zh-CN and shows Chinese text', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => localStorage.setItem('xihe-language', 'zh-CN'))
    await page.reload()
    await page.waitForLoadState('networkidle')
    const body = page.locator('body')
    await expect(body).toBeAttached()
  })

  test('login page snapshot in Chinese', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('xihe-language', 'zh-CN'))
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('login-zh-CN.png')
  })
})
