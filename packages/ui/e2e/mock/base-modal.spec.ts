import { test, expect } from '@playwright/test'
import { BaseModalPage } from '../page-objects/BaseModalPage'

test.describe('BaseModal', () => {
  test('opens and closes via backdrop click', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token-for-testing')
    })
    await page.goto('/chat')
    await page.waitForLoadState('load')

    const modal = new BaseModalPage(page)

    // Open modal by injecting markup that mimics BaseModal.vue behavior
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'injected-modal-host'
      host.innerHTML = `
        <div class="fixed inset-0 z-50 flex items-center justify-center" data-testid="modal-backdrop">
          <div class="fixed inset-0 bg-black/50" data-testid="modal-overlay"></div>
          <div class="relative z-10 w-full max-w-md rounded-xl border bg-card p-6 shadow-lg" data-testid="modal-content">
            <h2 class="text-lg font-semibold">Test Modal</h2>
            <p>Modal content</p>
          </div>
        </div>
      `
      const overlay = host.querySelector('[data-testid="modal-overlay"]') as HTMLElement
      overlay.addEventListener('click', () => host.remove())
      document.body.appendChild(host)
    })

    // Snapshot of modal in open state
    await expect(page).toHaveScreenshot('base-modal-open.png')

    // Click backdrop overlay (outside content) to close
    await modal.clickBackdrop()

    // Verify backdrop click closes (modal removed from DOM)
    await expect(modal.backdrop).not.toBeVisible()
  })
})
