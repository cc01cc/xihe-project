import { test, expect } from '@playwright/test'

test.describe('Config Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token')
    })
  })

  async function mockConfigAPIs(page: any) {
    const mockData: Record<string, Record<string, string>> = {
      'logging': { logLevel: 'info', levelAgent: 'debug' },
      'llm-provider': { deepseekApiKey: 'sk-ds-xxxx', openaiApiKey: 'sk-oa-xxxx', defaultProvider: 'deepseek' },
      'embedding': { model: 'text-embedding-3-small', dimensions: '1536' },
      'user-preference': { defaultModel: 'deepseek-chat', maxTokens: '4096', temperature: '0.7' },
      'workspace-config': { workspaceId: 'ws-1', image: 'xihe-workspace:latest' },
      'infrastructure': { dbUrl: 'jdbc:postgresql://localhost:5432/xihe', jwtSecret: '****' },
    }
    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
    })
    for (const [domain, data] of Object.entries(mockData)) {
      await page.route(`**/api/v1/config/${domain}`, async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) })
      })
    }
    await page.route('**/api/v1/events**', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
    await page.route('**/api/v1/exec', (route) => route.fulfill({ status: 200, body: 'OK' }))
  }

  test('shows loading state', async ({ page }) => {
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }))
    await page.route('**/api/v1/config/**', async (route) => {
      await new Promise(r => setTimeout(r, 3000))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
    })
    await page.route('**/api/v1/events**', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
    await page.route('**/api/v1/exec', (route) => route.fulfill({ status: 200, body: 'OK' }))
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.locator('text=加载中...')).toBeVisible()
    await expect(page).toHaveScreenshot('config-loading.png')
  })

  test('shows error on fetch failure', async ({ page }) => {
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }))
    await page.route('**/api/v1/config/**', (route) => route.abort('connectionrefused'))
    await page.route('**/api/v1/events**', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
    await page.route('**/api/v1/exec', (route) => route.fulfill({ status: 200, body: 'OK' }))
    await page.goto('/settings/config', { waitUntil: 'load' })
    await page.waitForTimeout(1000)
    await expect(page).toHaveScreenshot('config-error.png')
  })

  test('renders tab bar and admin tab by default', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })
    await page.waitForTimeout(2000)
    await expect(page.locator('button:has-text("管理员")').first()).toBeVisible()
    await expect(page.locator('button:has-text("系统")').first()).toBeVisible()
    await expect(page.locator('button:has-text("用户")').first()).toBeVisible()
    await expect(page).toHaveScreenshot('config-admin-tab.png')
  })

  test('switches between System and User tabs', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })
    await page.waitForTimeout(2000)

    await page.locator('button:has-text("系统")').first().click()
    await page.waitForTimeout(500)
    await expect(page).toHaveScreenshot('config-system-tab.png')

    await page.locator('button:has-text("用户")').first().click()
    await page.waitForTimeout(500)
    await expect(page).toHaveScreenshot('config-user-tab.png')
  })

  test('expands domain accordion panel', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })
    await page.waitForTimeout(2000)

    await page.locator('button:has-text("LLM 提供商")').click()
    await page.waitForTimeout(500)
    await expect(page.locator('text=DeepSeek API Key').first()).toBeVisible()
    const fields = page.locator(String.raw`.flex.items-center.gap-2 > .text-muted-foreground.w-1\/3`)
    await expect(fields).toHaveCount(9)
    await expect(page).toHaveScreenshot('config-domain-expanded.png')
  })

  test('shows readonly fields in system tab', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })
    await page.waitForTimeout(2000)

    await page.locator('button:has-text("系统")').first().click()
    await page.waitForTimeout(500)
    await page.locator('button:has-text("LLM 提供商")').click()
    await page.waitForTimeout(500)
    await expect(page).toHaveScreenshot('config-system-readonly.png')
  })
})
