import { test, expect } from '@playwright/test'
import { setupMockAuth } from './helpers/auth'

test.describe('Session Management', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)

    await page.addInitScript(() => {
      const sessions = [
        { id: 'sid-1', title: 'Alpha', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 'sid-2', title: 'Beta', createdAt: new Date(Date.now() - 86400000).toISOString(), updatedAt: new Date(Date.now() - 86400000).toISOString() },
        { id: 'sid-3', title: 'Gamma', createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), updatedAt: new Date(Date.now() - 2 * 86400000).toISOString() },
      ]
      localStorage.setItem('xihe-sessions', JSON.stringify(sessions))
    })
  })

  test('sidebar lists all seeded sessions', async ({ page }) => {
    await page.goto('/chat/sid-1')

    await expect(page.locator('aside >> text=Alpha')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('aside >> text=Beta')).toBeVisible()
    await expect(page.locator('aside >> text=Gamma')).toBeVisible()
    await expect(page).toHaveScreenshot('session-list-all.png')
  })

  test('clicking a session selects it as active', async ({ page }) => {
    await page.goto('/chat/sid-1')

    await page.locator('aside >> text=Beta').click()

    await expect(page.locator('aside >> text=Beta').locator('xpath=..')).toHaveClass(/bg-accent/)
  })

  test('sidebar time group headers are visible', async ({ page }) => {
    await page.goto('/chat/sid-1')

    await expect(page.locator('aside >> text=今天').first()).toBeVisible({ timeout: 5000 })
    await expect(page).toHaveScreenshot('session-time-groups.png')
  })

  test('search filters sessions by title', async ({ page }) => {
    await page.goto('/chat/sid-1')

    const searchInput = page.locator('input[placeholder*="搜索"]')
    await searchInput.fill('Alpha')

    await expect(page.locator('aside >> text=Alpha')).toBeVisible()
    await expect(page.locator('aside >> text=Beta')).toBeHidden({ timeout: 3000 })
    await expect(page.locator('aside >> text=Gamma')).toBeHidden({ timeout: 3000 })
    await expect(page).toHaveScreenshot('session-search-filtered.png')
  })

  test('clearing search restores all sessions', async ({ page }) => {
    await page.goto('/chat/sid-1')

    const searchInput = page.locator('input[placeholder*="搜索"]')
    await searchInput.fill('Alpha')
    await expect(page.locator('aside >> text=Beta')).toBeHidden({ timeout: 3000 })

    await searchInput.fill('')
    await expect(page.locator('aside >> text=Alpha')).toBeVisible()
    await expect(page.locator('aside >> text=Beta')).toBeVisible()
    await expect(page.locator('aside >> text=Gamma')).toBeVisible()
  })

  test('search with no match shows empty state', async ({ page }) => {
    await page.goto('/chat/sid-1')

    const searchInput = page.locator('input[placeholder*="搜索"]')
    await searchInput.fill('NonExistent')

    await expect(page.locator('text=暂无对话')).toBeVisible({ timeout: 3000 })
    await expect(page).toHaveScreenshot('session-search-no-match.png')
  })

  test('sidebar toggle hides sidebar', async ({ page }) => {
    await page.goto('/chat/sid-1')

    const sidebar = page.locator('aside')
    await expect(sidebar).toBeVisible()

    const toggleBtn = sidebar.locator('button').first()
    await toggleBtn.click()

    // width lands at 1px due to border; check it's effectively hidden
    const width = await sidebar.evaluate((el) => parseFloat(el.style.width))
    expect(width).toBeLessThan(2)
  })
})
