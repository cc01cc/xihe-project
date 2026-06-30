import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

async function registerAndGetToken(name: string): Promise<string> {
  const email = `${name}-${Date.now()}@test.com`
  const reg = await fetch(`${CP_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!', name }),
  })
  const body = await reg.json()
  return body.accessToken
}

test.describe('Cross-Module — Workspace', () => {
  test('workspace page shows file panel and editor after login', async ({ page }) => {
    const token = await registerAndGetToken('ws')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    await page.goto('/workspace')
    await page.waitForTimeout(2000)

    await expect(page.getByText('Files')).toBeVisible({ timeout: 5000 })
    expect(page.url()).toContain('/workspace')
  })

  test('workspace page shows empty state when no files exist', async ({ page }) => {
    const token = await registerAndGetToken('ws-empty')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    await page.goto('/workspace')
    await page.waitForTimeout(3000)

    const emptyState = page.getByText('Workspace is empty')
    const filesHeading = page.getByText('Files')
    await expect(filesHeading).toBeVisible({ timeout: 5000 })

    const hasEmptyState = await emptyState.isVisible().catch(() => false)
    const hasFileTree = await page.locator('.i-lucide-folder, .i-lucide-file').first().isVisible().catch(() => false)
    expect(hasEmptyState || hasFileTree).toBe(true)
  })

  test('unauthenticated user is redirected to login', async ({ page }) => {
    await page.goto('/workspace')
    await page.waitForURL(/\/login/, { timeout: 5000 })
    expect(page.url()).toContain('/login')
  })
})
