import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

async function registerAndLogin(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext, name: string) {
  const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
    data: { email: `${name}-${Date.now()}@test.com`, password: 'Test1234!', name },
  })
  const auth = await reg.json()
  await page.addInitScript(({ token, user, workspaceId }) => {
    localStorage.setItem('xihe-token', token)
    localStorage.setItem('xihe-user', JSON.stringify({ ...user, workspaceId }))
  }, { token: auth.accessToken, user: auth.user, workspaceId: auth.workspaceId })
  return auth
}

test.describe('Settings — Tier Tabs & Interactions', () => {
  test('config layer tabs switch without layout shift', async ({ page, request }) => {
    await registerAndLogin(page, request, 'tier-tabs')
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.locator('[data-testid="settings-config-heading"]')).toBeVisible({ timeout: 10000 })

    for (const tab of ['system', 'admin', 'user']) {
      const tabBtn = page.locator(`[data-testid="settings-nav-${tab}"], button`).filter({ hasText: new RegExp(tab, 'i') }).first()
      if (await tabBtn.count() > 0) {
        await tabBtn.click()
        await page.waitForTimeout(500)
        await expect(page).toHaveScreenshot(`settings-tier-${tab}.png`)
      }
    }
  })

  test('saving a config value triggers success toast that does not cover the save button', async ({ page, request }) => {
    await registerAndLogin(page, request, 'save-toast')
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.locator('[data-testid="settings-config-heading"]')).toBeVisible({ timeout: 10000 })

    const userTab = page.locator('button').filter({ hasText: /user|用户/i }).first()
    if (await userTab.count() > 0) await userTab.click()
    await page.waitForTimeout(500)

    const firstPanel = page.locator('button').filter({ hasText: /logging|rag|llm|mcp|embedding|workspace/i }).first()
    await expect(firstPanel).toBeVisible({ timeout: 8000 })
    await firstPanel.click()
    await page.waitForTimeout(500)

    const editInput = page.locator('input[type="text"]').first()
    await expect(editInput).toBeVisible({ timeout: 8000 })
    await editInput.fill(`e2e-${Date.now()}`)

    const saveBtn = page.locator('button').filter({ hasText: /save|保存/i }).first()
    await expect(saveBtn).toBeVisible()
    await saveBtn.click()

    const toast = page.locator('[data-sonner-toast]').first()
    await expect(toast).toBeVisible({ timeout: 8000 })

    const saveBox = await saveBtn.boundingBox()
    const toastBox = await toast.boundingBox()
    if (saveBox && toastBox) {
      const overlap = !(toastBox.x + toastBox.width < saveBox.x ||
        toastBox.x > saveBox.x + saveBox.width ||
        toastBox.y + toastBox.height < saveBox.y ||
        toastBox.y > saveBox.y + saveBox.height)
      expect(overlap).toBe(false)
    }
    await expect(page).toHaveScreenshot('settings-save-toast.png')
  })

  test('monitoring page table columns stay within viewport', async ({ page, request }) => {
    await registerAndLogin(page, request, 'monitor-cols')
    await page.goto('/settings/monitoring', { waitUntil: 'load' })
    await expect(page.locator('[data-testid="settings-monitoring-heading"]')).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(1500)

    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement
      return doc ? doc.scrollWidth - doc.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(2)
    await expect(page).toHaveScreenshot('settings-monitoring-table.png')
  })
})

test.describe('Settings — Remote MCP OAuth button states', () => {
  test('authorize button transitions through pending to authorized with screenshots', async ({ page, request }) => {
    const auth = await registerAndLogin(page, request, 'oauth-states')
    const serverId = randomUUID()
    const fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT || '13640'
    const uiPort = process.env.XIHE_UI_PORT || '12630'

    const save = await request.put(`${CP_URL}/api/v1/workspaces/${auth.workspaceId}/mcp-config`, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      data: {
        mcpServers: {
          [serverId]: {
            name: 'State fixture',
            url: 'https://example.com/mcp',
            oauth: {
              clientId: 'xihe-e2e-client',
              authorizationEndpoint: `http://localhost:${fakeOAuthPort}/authorize`,
              tokenEndpoint: `http://host.docker.internal:${fakeOAuthPort}/token`,
              redirectUri: `http://localhost:${uiPort}/settings/config`,
              scope: 'mcp:tools',
            },
          },
        },
      },
    })
    expect(save.ok()).toBe(true)

    await page.goto('/settings/config', { waitUntil: 'load' })
    const serverRow = page.locator(`[data-testid="remote-mcp-${serverId}"]`)
    await expect(serverRow).toBeVisible({ timeout: 10000 })
    await expect(page).toHaveScreenshot('mcp-oauth-before.png')

    await serverRow.locator('button').click()
    await page.waitForURL(/\/settings\/config(?:\?|$)/, { timeout: 10000 })
    await expect(serverRow).toContainText(/已授权|Authorized/, { timeout: 10000 })
    await expect(page).toHaveScreenshot('mcp-oauth-authorized.png')
  })
})
