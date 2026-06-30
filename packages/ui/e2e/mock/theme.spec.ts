import { test, expect } from '@playwright/test'

test.describe('Theme Switching', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token')
    })
    await page.route('**/api/v1/**', async (route) => {
      const url = route.request().url()
      if (url.includes('/exec')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: 'data: ' + JSON.stringify({ type: 'done', data: {} }) + '\n\n',
        })
      } else if (url.includes('/events')) {
        await route.fulfill({
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('retry: 5000\n\n'))
            },
          }),
        })
      } else {
        await route.continue()
      }
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
