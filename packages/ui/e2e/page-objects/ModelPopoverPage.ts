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
    // reka-ui ListboxItem commits the selection through keyboard navigation;
    // a synthetic click on the item does not select it. Filter to the model
    // and confirm with Enter — the exact match is the first filter result.
    void provider
    await this.searchInput.fill(model)
    await this.page.waitForTimeout(200)
    await this.searchInput.press('Enter')
  }

  async toggleFavorite(provider: string, model: string): Promise<void> {
    const fav = this.favoriteLocator(provider, model)
    await fav.dispatchEvent('click')
  }

  async search(term: string): Promise<void> {
    await this.searchInput.fill(term)
  }
}
