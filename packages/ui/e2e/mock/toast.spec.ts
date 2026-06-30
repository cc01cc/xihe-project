import { test, expect } from '@playwright/test'

test.describe('Toast notifications', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token-for-testing')
    })
    await page.goto('/chat')
    await page.waitForLoadState('networkidle')
  })

  test('renders toast container on page', async ({ page }) => {
    const container = page.locator('[aria-live="polite"]')
    await expect(container).toBeVisible()
  })

  test('displays success toast and captures snapshot', async ({ page }) => {
    // Inject toast elements directly to simulate display
    await page.evaluate(() => {
      const container = document.createElement('div')
      container.setAttribute('aria-live', 'polite')
      container.className = 'fixed bottom-4 right-4 z-[9999] flex flex-col-reverse gap-2'
      const toast = document.createElement('div')
      toast.className = 'max-w-xs rounded-lg px-4 py-3 text-sm shadow-lg border backdrop-blur-sm bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200'
      toast.textContent = 'File saved successfully'
      container.appendChild(toast)
      document.body.appendChild(container)
    })
    await page.waitForTimeout(300)
    await expect(page).toHaveScreenshot('toast-success.png')
  })

  test('displays error toast and captures snapshot', async ({ page }) => {
    await page.evaluate(() => {
      const container = document.createElement('div')
      container.setAttribute('aria-live', 'polite')
      container.className = 'fixed bottom-4 right-4 z-[9999] flex flex-col-reverse gap-2'
      const toast = document.createElement('div')
      toast.className = 'max-w-xs rounded-lg px-4 py-3 text-sm shadow-lg border backdrop-blur-sm bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
      toast.textContent = 'Connection failed. Please try again.'
      container.appendChild(toast)
      document.body.appendChild(container)
    })
    await page.waitForTimeout(300)
    await expect(page).toHaveScreenshot('toast-error.png')
  })

  test('displays warning toast and captures snapshot', async ({ page }) => {
    await page.evaluate(() => {
      const container = document.createElement('div')
      container.setAttribute('aria-live', 'polite')
      container.className = 'fixed bottom-4 right-4 z-[9999] flex flex-col-reverse gap-2'
      const toast = document.createElement('div')
      toast.className = 'max-w-xs rounded-lg px-4 py-3 text-sm shadow-lg border backdrop-blur-sm bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800 text-yellow-800 dark:text-yellow-200'
      toast.textContent = 'Storage space is running low'
      container.appendChild(toast)
      document.body.appendChild(container)
    })
    await page.waitForTimeout(300)
    await expect(page).toHaveScreenshot('toast-warning.png')
  })
})
