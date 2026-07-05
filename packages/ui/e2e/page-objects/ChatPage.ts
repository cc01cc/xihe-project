import { expect, type Page, type Locator } from '@playwright/test'

export class ChatPage {
  readonly page: Page
  readonly input: Locator
  readonly sendButton: Locator
  readonly stopButton: Locator
  readonly scrollerViewport: Locator
  readonly scrollerButton: Locator

  constructor(page: Page) {
    this.page = page
    this.input = page.locator('[data-testid="chat-input"]')
    this.sendButton = page.locator('[data-testid="chat-send-button"]')
    this.stopButton = page.locator('[data-testid="chat-stop-button"]')
    this.scrollerViewport = page.locator('[data-testid="message-scroller-viewport"]')
    this.scrollerButton = page.locator('[data-testid="message-scroller-button"]')
  }

  async goto(sessionId?: string): Promise<void> {
    const path = sessionId ? `/chat/${sessionId}` : '/chat'
    await this.page.goto(path)
  }

  async sendMessage(text: string): Promise<void> {
    await this.input.fill(text)
    await this.input.press('Enter')
  }

  messageLocator(text: string): Locator {
    return this.page.locator('text=' + text)
  }

  async scrollToTop(): Promise<void> {
    await this.scrollerViewport.evaluate((el) => {
      el.scrollTop = 0
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
