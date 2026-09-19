import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
import { test, expect } from '@playwright/test'

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

})

