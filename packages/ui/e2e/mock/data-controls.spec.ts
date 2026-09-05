import { test, expect } from '@playwright/test'

test.describe('Data Controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token')
      localStorage.setItem('xihe-language', 'en')
    })
  })

  test('renders export and import buttons', async ({ page }) => {
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }))
    await page.route('**/api/v1/events**', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
    await page.goto('/settings/data', { waitUntil: 'load' })
    await page.waitForTimeout(1000)
    await expect(page.locator('button:has-text("导出设置")')).toBeVisible()
    await expect(page.locator('button:has-text("导出聊天")')).toBeVisible()
    await expect(page.locator('button:has-text("导入")')).toBeVisible()
    await expect(page).toHaveScreenshot('data-controls-buttons.png')
  })
})
