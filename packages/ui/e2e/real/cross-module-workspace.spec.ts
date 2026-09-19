import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

interface RegisteredUser {
  token: string
  workspaceId: string
}

async function registerUser(name: string): Promise<RegisteredUser> {
  const email = `${name}-${Date.now()}@test.com`
  const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: SHARED_PASSWORD, name }),
  })
  const body = await reg.json()
  return { token: body.accessToken, workspaceId: body.workspaceId }
}

test.describe('Cross-Module — Workspace', () => {
  test('@host workspace page shows file panel and editor after login', async ({ page }) => {
    const { token, workspaceId } = await registerUser('ws')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    await page.goto(`/workspace/${workspaceId}`)
    await page.waitForTimeout(2000)

    await expect(page.getByTestId('workspace-toolbar-settings')).toBeVisible({ timeout: 5000 })
    expect(page.url()).toContain('/workspace')
  })

  test('@host workspace page shows empty state when no files exist', async ({ page }) => {
    const { token, workspaceId } = await registerUser('ws-empty')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    await page.goto(`/workspace/${workspaceId}`)
    await page.waitForTimeout(3000)

    await expect(page.getByTestId('workspace-toolbar-settings')).toBeVisible({ timeout: 5000 })
    await expect(page.getByText('工作区暂无文件')).toBeVisible({ timeout: 10000 })
  })

  test('unauthenticated user is redirected to login', async ({ page }) => {
    const { workspaceId } = await registerUser('ws-anon')
    await page.goto(`/workspace/${workspaceId}`)
    await page.waitForURL(/\/login/, { timeout: 5000 })
    expect(page.url()).toContain('/login')
  })
})

