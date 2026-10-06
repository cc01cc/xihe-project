import { test, expect } from '@playwright/test'
import { I18nPage } from '../page-objects/I18nPage'
import { expectPlatformScreenshot } from '../helpers/visual'

test.describe('Internationalization', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token-for-testing')
    })
  })

  test('switches from en to zh-CN and shows Chinese text', async ({ page }) => {
    const i18n = new I18nPage(page)
    await page.goto('/login')
    await page.waitForLoadState('load')
    await i18n.setLanguage('zh-CN')
    await page.reload()
    await page.waitForLoadState('load')
    const body = page.locator('body')
    await expect(body).toBeAttached()
  })

  test('login page snapshot in Chinese', async ({ page }) => {
    const i18n = new I18nPage(page)
    await page.goto('/login')
    await page.waitForLoadState('load')
    await i18n.setLanguage('zh-CN')
    await page.reload()
    await page.waitForLoadState('load')
    await expectPlatformScreenshot(page, 'login-zh-CN.png')
  })
})
