import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('Cross-Module — Auth Guard', () => {
  test('authenticated user can access chat page', async ({ page }) => {
    const email = `auth-${Date.now()}@test.com`
    const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Test1234!', name: 'AuthTest' }),
    })
    const { accessToken } = await reg.json()

    await page.addInitScript((token) => {
      localStorage.setItem('xihe-token', token)
    }, accessToken)

    await page.goto('/chat')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })
  })

  test('unauthenticated user is redirected to login', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForURL(/\/login/, { timeout: 5000 })
    expect(page.url()).toContain('/login')
  })
})
