import { generateE2EPassword } from './helpers/password'
import { gotoWorkspaceWithChat } from './helpers/chat'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('Mobile Viewport (390x844)', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  let authToken = ''
  let authWorkspaceId = ''

  test.beforeAll(async ({ request }) => {
    const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `mobile-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: 'Mobile' },
    })
    const body = await r.json()
    authToken = body.accessToken
    authWorkspaceId = body.workspaceId
    // On mobile the conversation column is unmounted (WorkspaceView v-if);
    // the chat FAB only renders once a Session exists. Seed one via API.
    await request.post(`${CP_URL}/api/v1/sessions`, {
      headers: { Authorization: `Bearer ${authToken}`, 'X-Workspace-Id': authWorkspaceId },
      data: {},
    })
  })

  async function assertNoHorizontalOverflow(page: import('@playwright/test').Page) {
    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement
      return doc ? doc.scrollWidth - doc.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(2)
  }

  test('login page renders within mobile viewport', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'load' })
    await page.waitForTimeout(800)
    await assertNoHorizontalOverflow(page)
    await expect(page).toHaveScreenshot('mobile-login.png')
  })

  test('chat page input area stays on screen on mobile', async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
    await gotoWorkspaceWithChat(page)

    const textarea = page.locator('textarea')
    const box = await textarea.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y + box!.height).toBeLessThanOrEqual(844)
    expect(box!.x + box!.width).toBeLessThanOrEqual(392)

    await assertNoHorizontalOverflow(page)
    await expect(page).toHaveScreenshot('mobile-chat.png')
  })

  test('settings config page renders within mobile viewport', async ({ page }) => {
    await page.addInitScript(({ token, workspaceId }) => {
      localStorage.setItem('xihe-token', token)
      localStorage.setItem('xihe-workspace', JSON.stringify({ id: workspaceId, name: 'Default Workspace' }))
    }, { token: authToken, workspaceId: authWorkspaceId })
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.locator('[data-testid="settings-config-heading"]')).toBeVisible({ timeout: 10000 })
    await page.getByTestId('config-tab-workspace').click()
    await page.locator('[data-testid="mcp-config-textarea"]').waitFor({ state: 'visible', timeout: 10000 })
    await assertNoHorizontalOverflow(page)
    await page.screenshot({ path: test.info().outputPath('mobile-settings-config.png'), fullPage: true })
  })

  test('mobile chat dialogs remain closable', async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
    await page.goto('/workspace', { waitUntil: 'load' })
    const fab = page.getByRole('button', { name: 'Open chat' })
    await expect(fab).toBeVisible({ timeout: 10000 })
    expect(await page.locator('[role="dialog"]').count()).toBe(0)

    await fab.click()
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })
    await page.keyboard.press('Escape')
    await expect
      .poll(async () => page.locator('[role="dialog"]').count(), { timeout: 5000 })
      .toBe(0)
  })
})

