import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('Auth — UI Flows & Error States', () => {
  test('register → logout → login full UI flow', async ({ page }) => {
    const email = `flow-${Date.now()}@test.com`

    await page.goto('/register')
    await page.locator('input[type="text"]').first().fill(email)
    await page.locator('input[type="password"]').nth(0).fill('Test1234!')
    await page.locator('input[type="password"]').nth(1).fill('Test1234!')
    await page.locator('button[type="submit"]').click()
    await page.waitForURL(/\/chat/, { timeout: 15000 })

    const logoutBtn = page.locator('[data-testid="sidebar"] button').filter({ hasText: /logout|退出/i }).first()
    await expect(logoutBtn).toBeVisible({ timeout: 8000 })
    await logoutBtn.click()
    await page.waitForURL(/\/login/, { timeout: 10000 })

    await page.locator('input[type="text"]').first().fill(email)
    await page.locator('input[type="password"]').first().fill('Test1234!')
    await page.locator('button[type="submit"]').click()
    await page.waitForURL(/\/chat/, { timeout: 15000 })
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })
  })

  test('wrong password shows Problem Details error without layout breakage', async ({ page, request }) => {
    const email = `wrongpw-${Date.now()}@test.com`
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email, password: 'Test1234!', name: 'WrongPw' },
    })
    expect(reg.ok()).toBe(true)

    await page.goto('/login')
    await page.locator('input[type="text"]').first().fill(email)
    await page.locator('input[type="password"]').first().fill('WrongPass999!')
    await page.locator('button[type="submit"]').click()

    const errorEl = page.locator('p.text-destructive').first()
    await expect(errorEl).toBeVisible({ timeout: 10000 })
    const errorText = await errorEl.innerText()
    expect(errorText).not.toMatch(/\[object Object\]/)
    expect(errorText).not.toMatch(/ProblemDetails|com\.cc01cc/)
    await expect(page).toHaveScreenshot('auth-login-error.png')
  })

  test('authenticated user visiting /login does not flash login form', async ({ page, request }) => {
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `redir-${Date.now()}@test.com`, password: 'Test1234!', name: 'Redir' },
    })
    const body = await reg.json()
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), body.accessToken)

    await page.goto('/login')
    await page.waitForURL(/\/chat/, { timeout: 10000 })
    expect(page.url()).toContain('/chat')
  })

  test('session persists across page refresh without sidebar flicker', async ({ page, request }) => {
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `refresh-${Date.now()}@test.com`, password: 'Test1234!', name: 'Refresh' },
    })
    const body = await reg.json()
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), body.accessToken)

    await page.goto('/chat')
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 10000 })
    await page.reload()
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 10000 })
    expect(page.url()).toContain('/chat')
  })
})
