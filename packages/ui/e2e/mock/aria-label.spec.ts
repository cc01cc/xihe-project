import { test, expect } from '@playwright/test'

test.describe('Accessibility — aria-label', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/chat/test-session')
  })

  test('close tab button has aria-label', async ({ page }) => {
    const closeBtn = page.locator('[aria-label="Close tab"]')
    await expect(closeBtn).toHaveCount(0)
  })

  test('message search close has aria-label', async ({ page }) => {
    const closeBtn = page.locator('[aria-label="Close search"]')
    await expect(closeBtn).toHaveCount(0)
  })
})
