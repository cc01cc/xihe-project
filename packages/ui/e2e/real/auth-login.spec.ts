import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('Auth — Real Backend', () => {
  let _authToken = ''

  test.beforeAll(async ({ request }) => {
    const r = await request.post(`${CP_URL}/auth/register`, {
      data: { email: `real-auth-${Date.now()}@test.com`, password: 'Test1234!', name: 'RealAuth' },
    })
    if (r.ok()) {
      const body = await r.json()
      _authToken = body.accessToken
    }
  })

  test('login page loads and shows form', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('h1')).toBeVisible({ timeout: 8000 })
    await expect(page).toHaveScreenshot('real-login-page.png')
  })

  test('register page loads and shows form', async ({ page }) => {
    await page.goto('/register')
    await expect(page.locator('h1')).toBeVisible({ timeout: 8000 })
    await expect(page).toHaveScreenshot('real-register-page.png')
  })

  test('navigates to chat after successful login', async ({ page }) => {
    const email = `real-login-${Date.now()}@test.com`
    // Register first
    const reg = await fetch(`${CP_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Test1234!', name: 'LoginTest' }),
    })
    expect(reg.ok).toBeTruthy()

    // Login via UI
    await page.goto('/login')
    await page.fill('input[name="email"]', email)
    await page.fill('input[type="password"]', 'Test1234!')
    await page.click('button[type="submit"]')
    await page.waitForURL(/\/chat/, { timeout: 10000 })
    await expect(page.locator('#app')).toBeAttached()
  })
})
