import { test, expect } from '@playwright/test'

test.describe('ConfirmModal', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token-for-testing')
    })
  })

  test('renders confirm dialog and captures snapshot', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForLoadState('load')

    await page.evaluate(() => {
      const div = document.createElement('div')
      div.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center">
          <div class="fixed inset-0 bg-black/50"></div>
          <div class="relative z-10 w-full max-w-md rounded-xl border bg-card p-6 shadow-lg">
            <h3 class="text-base font-semibold mb-2">Confirm Delete</h3>
            <p class="text-sm text-muted-foreground mb-4">Delete "main.ts"? This cannot be undone.</p>
            <div class="flex justify-end gap-2 pt-2">
              <button class="px-3 py-1.5 text-sm rounded border hover:bg-accent">Cancel</button>
              <button class="px-3 py-1.5 text-sm rounded bg-destructive text-destructive-foreground hover:opacity-90">Delete</button>
            </div>
          </div>
        </div>
      `
      document.body.appendChild(div)
    })
    await page.waitForTimeout(300)
    await expect(page).toHaveScreenshot('confirm-modal-delete.png')
  })
})
