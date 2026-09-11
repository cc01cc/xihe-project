import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
let authToken = ''

test.beforeAll(async () => {
  const r = await fetch(`${CP_URL}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `vis-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: 'Visual' }),
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
  await page.goto('/settings/config', { waitUntil: 'load' })
})

test('settings config page renders', async ({ page }) => {
  await expect(page.locator('[data-testid="settings-config-heading"]')).toBeVisible({ timeout: 8000 })
  // PLAN-0307 T2.17: the three-layer settings page is verified with
  // action screenshots in the @host specs; mock `config-settings.spec.ts`
  // keeps the pixel baseline for this route.
  await page.screenshot({ path: test.info().outputPath('settings-config.png'), fullPage: true })
})

test('settings knowledge page with tab nav', async ({ page }) => {
  await page.locator('[data-testid="settings-nav-settings-knowledge"]').click()
  await expect(page.locator('[data-testid="settings-knowledge-heading"]')).toBeVisible()
  await expect(page).toHaveScreenshot('settings-knowledge.png')
})

test('settings data page with tab nav', async ({ page }) => {
  await page.locator('[data-testid="settings-nav-settings-data"]').click()
  await expect(page.locator('[data-testid="settings-data-heading"]')).toBeVisible()
  await expect(page).toHaveScreenshot('settings-data.png')
})

test('settings monitoring page with tab nav', async ({ page }) => {
  await page.locator('[data-testid="settings-nav-settings-monitoring"]').click()
  await expect(page.locator('[data-testid="settings-monitoring-heading"]')).toBeVisible()
  await expect(page).toHaveScreenshot('settings-monitoring.png')
})

