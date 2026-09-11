import { test, expect } from '@playwright/test'
import { ModelPopoverPage } from '../page-objects/ModelPopoverPage'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

test.describe('Model Popover', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    // Sessions are server-canonical (PLAN-029); the popover persists the
    // per-session binding, so the mock must expose the session endpoint.
    await setupMockSessions(page, { sessions: [{ id: 'sid-1', title: 'Test Chat' }] })

    await page.route('**/api/v1/models', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: {
            deepseek: ['deepseek-chat', 'deepseek-reasoner'],
            openai: ['gpt-4o'],
          },
          // PLAN-0307: the popover groups come from the provider catalog
          // (`providers`), which is grounded in provider connections.
          providers: {
            deepseek: {
              status: 'ready',
              models: [
                { name: 'deepseek-chat', capabilities: { chat: true, vision: false, tools: true } },
                { name: 'deepseek-reasoner', capabilities: { chat: true, vision: false, tools: true } },
              ],
            },
            openai: {
              status: 'ready',
              models: [
                { name: 'gpt-4o', capabilities: { chat: true, vision: true, tools: true } },
              ],
            },
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
