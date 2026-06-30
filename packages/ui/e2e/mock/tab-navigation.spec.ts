import { test, expect } from '@playwright/test'

test.describe('Keyboard accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token-for-testing')
    })
    await page.goto('/chat')
    await page.waitForLoadState('networkidle')
  })

  test('tab navigates through interactive elements', async ({ page }) => {
    // Press Tab multiple times and verify focus moves
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab')
      const focused = page.locator(':focus')
      await expect(focused).toBeAttached()
    }
  })

  test('focus-visible ring is visible on focused elements', async ({ page }) => {
    await page.keyboard.press('Tab')
    const focused = page.locator(':focus-visible')
    await expect(focused).toBeAttached()
  })

  test('focused button captured in snapshot', async ({ page }) => {
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    await expect(page).toHaveScreenshot('tab-focus-new-chat.png')
  })
})
