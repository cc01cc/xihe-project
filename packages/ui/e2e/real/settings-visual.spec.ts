import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
let authToken = ''

test.beforeAll(async () => {
  const r = await fetch(`${CP_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `vis-${Date.now()}@test.com`, password: 'Test1234!', name: 'Visual' }),
  })
  if (r.ok) {
    const body = await r.json()
    authToken = body.accessToken
  }
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript((t) => {
    localStorage.setItem('xihe-token', t)
    localStorage.setItem('xihe-user', JSON.stringify({ id: 'vis', name: 'Visual' }))
  }, authToken)
  await page.goto('/settings/model', { waitUntil: 'networkidle' })
})

test('settings model page with tab nav', async ({ page }) => {
  await expect(page.locator('nav a:has-text("模型配置")')).toBeVisible({ timeout: 8000 })
  await expect(page).toHaveScreenshot('settings-model.png')
})

test('settings knowledge page with tab nav', async ({ page }) => {
  await page.click('nav a:has-text("知识库")')
  await expect(page.locator('h3:has-text("知识库")')).toBeVisible()
  await expect(page).toHaveScreenshot('settings-knowledge.png')
})

test('settings data page with tab nav', async ({ page }) => {
  await page.click('nav a:has-text("数据管理")')
  await expect(page.locator('h3:has-text("数据管理")')).toBeVisible()
  await expect(page).toHaveScreenshot('settings-data.png')
})

test('settings mcp page with tab nav', async ({ page }) => {
  await page.click('nav a:has-text("MCP 服务")')
  await expect(page.locator('h2:has-text("MCP 服务")')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('textarea')).toBeVisible()
  await expect(page).toHaveScreenshot('settings-mcp.png')
})

test('settings theme page with tab nav', async ({ page }) => {
  await page.click('nav a:has-text("主题设置")')
  await expect(page.locator('h2:has-text("主题设置")')).toBeVisible({ timeout: 8000 })
  await expect(page).toHaveScreenshot('settings-theme.png')
})

test('settings config page with embedding panel', async ({ page }) => {
  await page.goto('/settings/config', { waitUntil: 'networkidle' })
  await expect(page.locator('text=Embedding')).toBeVisible({ timeout: 8000 })
  await expect(page).toHaveScreenshot('settings-config.png')
})
