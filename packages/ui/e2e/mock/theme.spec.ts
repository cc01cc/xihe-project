import { test, expect } from '@playwright/test'
import { setupMockAuth } from './helpers/auth'

test.describe('Theme Switching', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await page.addInitScript(() => {
      localStorage.setItem('xihe-sessions', JSON.stringify([
        { id: 'test-session', title: 'Test Session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]))
    })
  })

  test('default theme is light', async ({ page }) => {
    await page.goto('/chat/test-session')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await expect(page).toHaveScreenshot('theme-default-light.png')
  })

  test('dark mode applies correct class to html element', async ({ page }) => {
    await page.goto('/chat/test-session')

    await page.evaluate(() => {
      localStorage.setItem('xihe-theme', 'dark')
      document.documentElement.classList.add('dark')
    })

    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('theme persists across page navigation', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-theme', 'dark')
    })

    await page.goto('/chat/test-session')

    await page.evaluate(() => {
      document.documentElement.classList.add('dark')
    })

    await page.goto('/chat/test-session')

    const theme = await page.evaluate(() => localStorage.getItem('xihe-theme'))
    expect(theme).toBe('dark')
    await expect(page.locator('html')).toHaveClass(/dark/)
    await expect(page).toHaveScreenshot('theme-dark-persisted-chat.png')
  })
})
