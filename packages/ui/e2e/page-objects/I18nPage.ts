import type { Page } from '@playwright/test'

export class I18nPage {
  readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async setLanguage(locale: string): Promise<void> {
    await this.page.evaluate((value) => {
      localStorage.setItem('xihe-language', value)
    }, locale)
  }

  async getLanguage(): Promise<string | null> {
    return await this.page.evaluate(() => localStorage.getItem('xihe-language'))
  }
}
