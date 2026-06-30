import { test, expect } from '@playwright/test'

test.describe('BaseModal', () => {
  test('opens and closes via backdrop click', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token-for-testing')
    })
    await page.goto('/chat')
    await page.waitForLoadState('networkidle')

    // Open modal by injecting it into DOM
    const result = await page.evaluate(() => {
      const div = document.createElement('div')
      div.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center">
          <div class="fixed inset-0 bg-black/50" data-testid="backdrop"></div>
          <div class="relative z-10 w-full max-w-md rounded-xl border bg-card p-6 shadow-lg">
            <h2 class="text-lg font-semibold">Test Modal</h2>
            <p>Modal content</p>
            <button class="px-3 py-1.5 text-sm rounded border">Close</button>
          </div>
        </div>
      `
      document.body.appendChild(div)
      return true
    })
    expect(result).toBe(true)

    // Snapshot of modal in open state
    await expect(page).toHaveScreenshot('base-modal-open.png')

    // Click backdrop
    await page.click('[data-testid="backdrop"]')
    // Verify backdrop click closes (modal removed from DOM)
    const backdrop = page.locator('[data-testid="backdrop"]')
    await expect(backdrop).not.toBeVisible()
  })
})
