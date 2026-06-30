import { test, expect } from '@playwright/test'

test.describe('Authentication', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/**', async (route) => {
      const url = route.request().url()

      if (url.includes('/register')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ token: 'mock-token', user: { id: 'user-1', username: 'newuser' } }),
        })
      } else if (url.includes('/login')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ token: 'mock-token', user: { id: 'user-1', username: 'testuser' } }),
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

  test('login page renders', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveURL(/\/login/)
    await expect(page).toHaveScreenshot('login-page.png')
  })

  test('register page renders', async ({ page }) => {
    await page.goto('/register')
    await expect(page).toHaveURL(/\/register/)
    await expect(page).toHaveScreenshot('register-page.png')
  })
})
