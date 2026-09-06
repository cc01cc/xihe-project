import { test, expect } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

test.describe('Workspace management dialogs (PLAN-262 M2)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, {
      sessions: [{ id: 'session-1', title: 'Session 1' }],
      messages: { 'session-1': [] },
    })
    // Mock workspace CRUD contract (CP canonical shape per openapi.yaml)
    await page.route('**/api/v1/workspaces', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as Record<string, unknown>
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'ws-new',
            name: body.name ?? 'Untitled',
            description: body.description ?? null,
            ownerId: 'user-1',
            storageBackend: 'host_directory',
            storageRef: 'ws-new',
            generation: 1,
          }),
        })
        return
      }
      await route.fallback()
    })
    await page.route('**/api/v1/workspaces/*', async (route) => {
      const method = route.request().method()
      const url = new URL(route.request().url())
      const wsId = url.pathname.split('/').filter(Boolean).at(-1) ?? 'workspace-1'
      if (method === 'PATCH') {
        const body = route.request().postDataJSON() as Record<string, unknown>
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: wsId,
            name: body.name ?? 'Mock Workspace',
            description: body.description ?? null,
            ownerId: 'user-1',
            storageBackend: 'host_directory',
            storageRef: wsId,
            generation: 1,
          }),
        })
        return
      }
      if (method === 'DELETE') {
        await route.fulfill({ status: 204, body: '' })
        return
      }
      await route.fallback()
    })
  })

  test('empty state offers creation; create dialog posts profile and shows strict selection', async ({ page }) => {
    // No workspace in storage -> empty state (PLAN-262 decision 11)
    await page.addInitScript(() => {
      localStorage.removeItem('xihe-workspace')
    })
    await page.goto('/workspace/new')
    await expect(page.getByText('暂无工作区')).toBeVisible()
    await page.getByRole('button', { name: 'Create workspace' }).click()

    const dialog = page.getByTestId('workspace-create-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByPlaceholder('My Workspace').fill('E2E Workspace')
    // strict profile card
    await dialog.getByText('Strict', { exact: true }).click()
    await dialog.getByRole('button', { name: '创建' }).click()

    await expect(page).toHaveURL(/\/workspace\/ws-new/)
  })

  test('settings dialog saves rename and enforces exact-name delete guard', async ({ page }) => {
    await page.goto('/workspace/workspace-1')
    // Toolbar settings entry
    await page.getByTestId('workspace-toolbar-settings').click()
    const dialog = page.getByTestId('workspace-settings-dialog')
    await expect(dialog).toBeVisible()

    await dialog.locator('#ws-settings-name').fill('Renamed Workspace')
    await dialog.getByRole('button', { name: '保存' }).click()
    await expect(page.getByText('Workspace updated')).toBeVisible()

    // Delete flow: wrong name first, then exact name
    await page.getByTestId('workspace-toolbar-settings').click()
    await dialog.getByRole('button', { name: '删除…' }).click()
    const confirm = page.getByTestId('workspace-delete-confirm')
    await expect(confirm).toBeVisible()
    await confirm.locator('#ws-delete-confirm').fill('Wrong Name')
    await confirm.getByRole('button', { name: '确认删除' }).click()
    await expect(confirm.getByText('请输入完整的工作区名称以确认')).toBeVisible()

    await confirm.locator('#ws-delete-confirm').fill('Renamed Workspace')
    await confirm.getByRole('button', { name: '确认删除' }).click()
    await expect(page).toHaveURL(/\/chat\/default/)
  })
})
