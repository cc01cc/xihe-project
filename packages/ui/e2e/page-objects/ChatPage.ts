import { expect, type Page, type Locator } from '@playwright/test'

export class ChatPage {
  readonly page: Page
  readonly input: Locator
  readonly sendButton: Locator
  readonly stopButton: Locator
  readonly scrollerViewport: Locator
  readonly scrollerButton: Locator
  readonly fileInput: Locator
  readonly uploadIndicator: Locator

  constructor(page: Page) {
    this.page = page
    this.input = page.locator('[data-testid="chat-input"]')
    this.sendButton = page.locator('[data-testid="chat-send-button"]')
    this.stopButton = page.locator('[data-testid="chat-stop-button"]')
    this.scrollerViewport = page.locator('[data-testid="message-scroller-viewport"]')
    this.scrollerButton = page.locator('[data-testid="message-scroller-button"]')
    this.fileInput = page.locator('[data-testid="file-upload-input"]')
    this.uploadIndicator = page.locator('[data-testid="attachment-uploading-indicator"]')
  }

  async goto(sessionId?: string): Promise<void> {
    const path = sessionId ? `/chat/${sessionId}` : '/chat'
    await this.page.goto(path)
    await this.input.waitFor({ state: 'visible' })
  }

  async attachFiles(filePaths: (string | { name: string; mimeType: string; buffer: Buffer })[]): Promise<void> {
    await this.fileInput.setInputFiles(filePaths)
  }

  async sendMessage(text: string): Promise<void> {
    await this.input.fill(text)
    await this.input.press('Enter')
  }

  messageLocator(text: string): Locator {
    return this.page.locator('text=' + text)
  }

  attachmentLocator(name: string): Locator {
    return this.page.locator('[data-testid="message-attachment"]', { hasText: name })
  }

  async scrollToTop(): Promise<void> {
    await this.scrollerViewport.evaluate((el) => {
      // Mark the movement as user initiated so auto-scroll does not restore the end.
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -1 }))
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
  }

  async isScrollerButtonActive(): Promise<boolean> {
    const active = await this.scrollerButton.getAttribute('data-active')
    return active === 'true'
  }

  async expectScrollerButtonActive(): Promise<void> {
    await expect(this.scrollerButton).toHaveAttribute('data-active', 'true')
  }

  async expectScrollerButtonInactive(): Promise<void> {
    await expect(this.scrollerButton).toHaveAttribute('data-active', 'false')
  }

  async clickScrollerButton(): Promise<void> {
    await this.scrollerButton.click()
  }
}
