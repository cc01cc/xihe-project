import { test, expect } from '@playwright/test'

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
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('retry: 5000\n\n'))
          },
        }),
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

    const trigger = page.locator('button:has-text("Select Model"), button:has-text("选择模型")')
    await expect(trigger).toBeVisible({ timeout: 5000 })
  })

  test('clicking trigger opens popover with provider groups', async ({ page }) => {
    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const trigger = page.locator('button:has-text("Select Model"), button:has-text("选择模型")')
    await trigger.click()
    await page.waitForTimeout(500)

    await expect(page.locator('text=DeepSeek')).toBeVisible()
    await expect(page.locator('text=OpenAI')).toBeVisible()
    await expect(page.locator('text=deepseek-chat')).toBeVisible()
    await expect(page.locator('text=gpt-4o')).toBeVisible()
  })

  test('selecting a model updates trigger text and persists to localStorage', async ({ page }) => {
    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const trigger = page.locator('button:has-text("Select Model"), button:has-text("选择模型")')
    await trigger.click()
    await page.waitForTimeout(500)

    const modelBtn = page.locator('button:has-text("deepseek-chat")').last()
    await modelBtn.click()
    await page.waitForTimeout(500)

    await expect(trigger).toContainText('deepseek-chat')

    const stored = await page.evaluate(() => localStorage.getItem('xihe-session-models'))
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored!)
    expect(parsed['sid-1']).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
  })

  test('search filters models', async ({ page }) => {
    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const trigger = page.locator('button:has-text("Select Model"), button:has-text("选择模型")')
    await trigger.click()
    await page.waitForTimeout(500)

    const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="搜索"]')
    await searchInput.fill('reasoner')
    await page.waitForTimeout(300)

    await expect(page.locator('text=deepseek-reasoner')).toBeVisible()
    await expect(page.locator('button:has-text("gpt-4o")')).not.toBeVisible()
  })

  test('selected model persists after page reload', async ({ page }) => {
    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const trigger = page.locator('button:has-text("Select Model"), button:has-text("选择模型")')
    await trigger.click()
    await page.waitForTimeout(500)

    const modelBtn = page.locator('button:has-text("gpt-4o")').last()
    await modelBtn.click()
    await page.waitForTimeout(500)

    await page.reload()
    await page.waitForTimeout(2000)

    const reloadedTrigger = page.locator('button:has-text("gpt-4o")')
    await expect(reloadedTrigger).toBeVisible({ timeout: 5000 })
  })

  test('favorite toggle persists to localStorage', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-model-favorites', '[]')
    })

    await page.goto('/chat/sid-1')
    await page.waitForTimeout(2000)

    const trigger = page.locator('button:has-text("Select Model"), button:has-text("选择模型")')
    await trigger.click()
    await page.waitForTimeout(500)

    const starBtns = page.locator('[class*="i-lucide-star-off"]')
    const count = await starBtns.count()
    if (count > 0) {
      await starBtns.first().click()
      await page.waitForTimeout(300)

      const stored = await page.evaluate(() => localStorage.getItem('xihe-model-favorites'))
      expect(stored).toBeTruthy()
      const parsed = JSON.parse(stored!)
      expect(parsed.length).toBeGreaterThan(0)
    }
  })
})
