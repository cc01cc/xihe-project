import type { Page, Locator } from '@playwright/test'

export class ModelPopoverPage {
  readonly page: Page
  readonly trigger: Locator
  readonly searchInput: Locator

  constructor(page: Page) {
    this.page = page
    this.trigger = page.locator('[data-testid="model-popover-trigger"]')
    this.searchInput = page.locator('[data-testid="model-popover-search"]')
  }

  async open(): Promise<void> {
    await this.trigger.click()
  }

  groupLocator(provider: string): Locator {
    return this.page.locator(`[data-testid="model-group-${provider}"]`)
  }

  itemLocator(provider: string, model: string): Locator {
    return this.page.locator(`[data-testid="model-item-${provider}/${model}"]`)
  }

  favoriteLocator(provider: string, model: string): Locator {
    return this.page.locator(`[data-testid="model-favorite-${provider}/${model}"]`)
  }

  async selectModel(provider: string, model: string): Promise<void> {
    const item = this.itemLocator(provider, model)
    await item.dispatchEvent('click')
  }

  async toggleFavorite(provider: string, model: string): Promise<void> {
    const fav = this.favoriteLocator(provider, model)
    await fav.dispatchEvent('click')
  }

  async search(term: string): Promise<void> {
    await this.searchInput.fill(term)
  }
}
