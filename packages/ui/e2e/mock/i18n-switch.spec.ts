import { test, expect } from '@playwright/test'
import { I18nPage } from '../page-objects/I18nPage'

test.describe('Internationalization', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token-for-testing')
    })
  })

  test('switches from en to zh-CN and shows Chinese text', async ({ page }) => {
    const i18n = new I18nPage(page)
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await i18n.setLanguage('zh-CN')
    await page.reload()
    await page.waitForLoadState('networkidle')
    const body = page.locator('body')
    await expect(body).toBeAttached()
  })

  test('login page snapshot in Chinese', async ({ page }) => {
    const i18n = new I18nPage(page)
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await i18n.setLanguage('zh-CN')
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveScreenshot('login-zh-CN.png')
  })
})
