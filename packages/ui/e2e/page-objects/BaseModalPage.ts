import type { Page, Locator } from '@playwright/test'

export class BaseModalPage {
  readonly page: Page
  readonly backdrop: Locator
  readonly overlay: Locator
  readonly content: Locator

  constructor(page: Page) {
    this.page = page
    this.backdrop = page.locator('[data-testid="modal-backdrop"]')
    this.overlay = page.locator('[data-testid="modal-overlay"]')
    this.content = page.locator('[data-testid="modal-content"]')
  }

  async openWithInjectedHTML(html: string): Promise<void> {
    await this.page.evaluate((injectedHtml) => {
      const div = document.createElement('div')
      div.innerHTML = injectedHtml
      document.body.appendChild(div)
    }, html)
  }

  async clickBackdrop(): Promise<void> {
    // Click at the top-left corner of the overlay to avoid the centered modal content
    await this.overlay.click({ position: { x: 0, y: 0 } })
  }

  async isOpen(): Promise<boolean> {
    return await this.backdrop.isVisible().catch(() => false)
  }
}
