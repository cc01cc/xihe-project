import { test, expect } from '@playwright/test'
import { ModelPopoverPage } from '../page-objects/ModelPopoverPage'

test.describe('Model Popover', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token')
      localStorage.setItem('xihe-sessions', JSON.stringify([
        { id: 'sid-1', title: 'Test Chat', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]))
    })

    await page.route('**/api/v1/events**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: 'retry: 5000\n\n',
      })
    })

    await page.route('**/api/v1/exec', async (route) => {
      await route.fulfill({ status: 200, body: 'OK' })
    })

    await page.route('**/api/v1/models', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: {
            deepseek: ['deepseek-chat', 'deepseek-reasoner'],
            openai: ['gpt-4o'],
          },
        }),
      })
    })
  })

  test('model popover trigger button is visible', async ({ page }) => {
    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const popover = new ModelPopoverPage(page)
    await expect(popover.trigger).toBeVisible({ timeout: 5000 })
  })

  test('clicking trigger opens popover with provider groups', async ({ page }) => {
    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const popover = new ModelPopoverPage(page)
    await popover.open()
    await page.waitForTimeout(500)

    await expect(popover.groupLocator('deepseek')).toBeVisible()
    await expect(popover.groupLocator('openai')).toBeVisible()
    await expect(popover.itemLocator('deepseek', 'deepseek-chat')).toBeVisible()
    await expect(popover.itemLocator('openai', 'gpt-4o')).toBeVisible()
  })

  test('selecting a model updates trigger text and persists to localStorage', async ({ page }) => {
    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const popover = new ModelPopoverPage(page)
    await popover.open()
    await page.waitForTimeout(500)

    await popover.selectModel('deepseek', 'deepseek-chat')
    await page.waitForTimeout(500)

    await expect(popover.trigger).toContainText('deepseek-chat')

    const stored = await page.evaluate(() => localStorage.getItem('xihe-session-models'))
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored!)
    expect(parsed['sid-1']).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  test('search filters models', async ({ page }) => {
    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const popover = new ModelPopoverPage(page)
    await popover.open()
    await page.waitForTimeout(500)

    await popover.search('reasoner')
    await page.waitForTimeout(300)

    await expect(popover.itemLocator('deepseek', 'deepseek-reasoner')).toBeVisible()
    await expect(popover.itemLocator('openai', 'gpt-4o')).not.toBeVisible()
  })

  test('selected model persists after page reload', async ({ page }) => {
    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const popover = new ModelPopoverPage(page)
    await popover.open()
    await page.waitForTimeout(500)

    await popover.selectModel('openai', 'gpt-4o')
    await page.waitForTimeout(500)

    await page.reload()
    await page.waitForTimeout(2000)

    await expect(popover.trigger).toContainText('gpt-4o')
  })

  test('favorite toggle persists to localStorage', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-model-favorites', '[]')
    })

    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const popover = new ModelPopoverPage(page)
    await popover.open()
    await page.waitForTimeout(500)

    await popover.toggleFavorite('deepseek', 'deepseek-chat')
    await page.waitForTimeout(300)

    const stored = await page.evaluate(() => localStorage.getItem('xihe-model-favorites'))
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored!)
    expect(parsed.length).toBeGreaterThan(0)
  })
})
