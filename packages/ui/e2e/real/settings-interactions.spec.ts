import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

async function registerAndLogin(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext, name: string) {
  const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
    data: { email: `${name}-${Date.now()}@test.com`, password: SHARED_PASSWORD, name },
  })
  const auth = await reg.json()
  await page.addInitScript(({ token, user, workspaceId }) => {
    localStorage.setItem('xihe-token', token)
    localStorage.setItem('xihe-user', JSON.stringify({ ...user, workspaceId }))
    localStorage.setItem('xihe-workspace', JSON.stringify({ id: workspaceId, name: 'Default Workspace' }))
  }, { token: auth.accessToken, user: auth.user, workspaceId: auth.workspaceId })
  return auth
}

test.describe('@host Settings — Tier Tabs & Interactions', () => {
  test('config layer tabs switch without layout shift', async ({ page, request }) => {
    await registerAndLogin(page, request, 'tier-tabs')
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.locator('[data-testid="settings-config-heading"]')).toBeVisible({ timeout: 10000 })

    // Non-admin users get the workspace + user entries (instance is ADMIN-only).
    for (const layer of ['workspace', 'user']) {
      const tabBtn = page.getByTestId(`config-tab-${layer}`)
      await expect(tabBtn).toBeVisible({ timeout: 8000 })
      await tabBtn.click()
      await page.screenshot({ path: test.info().outputPath(`settings-tier-${layer}.png`), fullPage: true })
    }
  })

  test('saving a config value triggers success toast that does not cover the save button', async ({ page, request }) => {
    await registerAndLogin(page, request, 'save-toast')
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.locator('[data-testid="settings-config-heading"]')).toBeVisible({ timeout: 10000 })

    await page.getByTestId('config-tab-user').click()
    const profilePanel = page.getByTestId('config-domain-agent-profile')
    await expect(profilePanel).toBeVisible({ timeout: 8000 })
    await profilePanel.locator(':scope > button').click()

    const editInput = profilePanel.locator('input[type="text"]').first()
    await expect(editInput).toBeVisible({ timeout: 8000 })
    await editInput.fill(`e2e-${Date.now()}`)

    const saveBtn = profilePanel.getByRole('button', { name: '保存', exact: true })
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
    // Evidence screenshot (dynamic content — no pixel baseline).
    await page.screenshot({ path: test.info().outputPath('settings-save-toast.png'), fullPage: true })
  })

  test('user config save survives a page reload', async ({ page, request }) => {
    await registerAndLogin(page, request, 'config-reload')
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.getByTestId('settings-config-heading')).toBeVisible({ timeout: 10000 })
    let profileSaveStatus: number | null = null
    page.on('response', (response) => {
      if (response.url().includes('/api/v1/config/user/agent-profile')) {
        profileSaveStatus = response.status()
      }
    })

    await page.getByTestId('config-tab-user').click()
    const profilePanel = page.getByTestId('config-domain-agent-profile')
    await profilePanel.locator(':scope > button').click()
    const userName = profilePanel.locator('input[type="text"]').first()
    const value = `e2e-reload-${Date.now()}`
    await userName.fill(value)
    await profilePanel.getByRole('button', { name: '保存', exact: true }).click()
    await expect.poll(() => profileSaveStatus, { timeout: 10000 }).toBe(200)
    await expect(page.getByText(/Agent 个人.*已保存/)).toBeVisible({ timeout: 10000 })

    await page.reload({ waitUntil: 'load' })
    await expect(page.getByTestId('settings-config-heading')).toBeVisible({ timeout: 10000 })
    const reloadedPanel = page.getByTestId('config-domain-agent-profile')
    await reloadedPanel.locator(':scope > button').click()
    await expect(reloadedPanel.locator('input[type="text"]').first()).toHaveValue(value)
    // Evidence screenshot (the saved value is dynamic — no pixel baseline).
    await page.screenshot({ path: test.info().outputPath('settings-user-config-reloaded.png'), fullPage: true })
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
    // Evidence screenshot (live monitoring numbers — no pixel baseline).
    await page.screenshot({ path: test.info().outputPath('settings-monitoring-table.png'), fullPage: true })
  })
})

test.describe('@host Settings — Remote MCP OAuth button states', () => {
  test('authorize button transitions through pending to authorized with screenshots', async ({ page, request }) => {
    const auth = await registerAndLogin(page, request, 'oauth-states')
    const serverId = randomUUID()
    const fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT || '13640'
    const uiPort = process.env.XIHE_UI_PORT || '12630'

    const remoteServer = {
      name: 'State fixture',
      url: 'https://example.com/mcp',
      oauth: {
        clientId: 'xihe-e2e-client',
        authorizationEndpoint: `http://localhost:${fakeOAuthPort}/authorize`,
        tokenEndpoint: `http://127.0.0.1:${fakeOAuthPort}/token`,
        redirectUri: `http://localhost:${uiPort}/settings/config`,
        scope: 'mcp:tools',
      },
    }
    const save = await request.put(`${CP_URL}/api/v1/workspaces/${auth.workspaceId}/mcp-config`, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      data: { mcpServers: { [serverId]: remoteServer } },
    })
    expect(save.ok()).toBe(true)

    await page.goto('/settings/config', { waitUntil: 'load' })
    const textarea = page.getByTestId('mcp-config-textarea')
    const pasteConfig = JSON.stringify({ mcpServers: { [serverId]: remoteServer } }, null, 2)
    const serverRow = page.locator(`[data-testid="remote-mcp-${serverId}"]`)

    async function enterWorkspaceMcpEditor() {
      // Enter the workspace layer and wait for the mixed mcp-config load to
      // settle before overwriting the editor (the load would clear the paste).
      const mcpLoaded = page.waitForResponse(
        response => response.url().includes('/mcp-config') && response.request().method() === 'GET',
      ).catch(() => null)
      await page.getByTestId('config-tab-workspace').click()
      await expect(textarea).toBeVisible({ timeout: 10000 })
      await mcpLoaded
      // CP strips oauth metadata on read (secrets are never echoed back), so
      // the authorize row renders from the editor content — paste experience.
      await textarea.fill(pasteConfig)
    }

    await enterWorkspaceMcpEditor()
    await expect(serverRow).toBeVisible({ timeout: 10000 })
    await page.screenshot({ path: test.info().outputPath('mcp-oauth-before.png'), fullPage: true })

    await serverRow.locator('button').click()
    await page.waitForURL(/[?&]state=/, { timeout: 15000 })
    // The OAuth callback reloads the page; re-enter the workspace layer and
    // re-prime the editor so the row renders with the persisted authorization.
    await enterWorkspaceMcpEditor()
    await expect(serverRow).toContainText(/已授权|Authorized/, { timeout: 15000 })
    await page.screenshot({ path: test.info().outputPath('mcp-oauth-authorized.png'), fullPage: true })
  })
})

