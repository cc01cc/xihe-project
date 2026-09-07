import { expect, test, type Page } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

async function setupViewportFixtures(page: Page) {
  await setupMockAuth(page)
  await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Viewport Test' }] })
  await page.addInitScript(() => {
    localStorage.setItem('xihe-mock-filetree', JSON.stringify([]))
  })
  await page.route('**/api/v1/config/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({}),
  }))
  await page.route('**/api/v1/provider-catalog', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ catalogRevision: 'viewport', providers: [] }),
  }))
  await page.route('**/api/v1/provider-connections', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ connections: [] }),
  }))
  await page.route('**/api/v1/mcp', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: JSON.stringify({ entries: [] }) }] },
    }),
  }))
  await page.route('**/api/v1/workspaces/*/environment', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      workspaceId: 'workspace-1',
      status: 'ready',
      storageBackend: 'host_directory',
      storageRef: 'workspace-1',
      executionSpec: { status: 'assigned', generation: 1, sandboxSpecHash: 'viewport-spec' },
      runtime: { status: 'ready', deviceId: 'viewport-device', lastHeartbeatAt: 'now' },
    }),
  }))
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.scrollingElement
    return doc ? doc.scrollWidth - doc.clientWidth : 0
  })
  expect(overflow).toBeLessThanOrEqual(2)
}

test.describe('PLAN-269 viewport matrix: desktop-4k', () => {
  test.use({ viewport: { width: 3840, height: 2160 }, deviceScaleFactor: 1 })

  test('settings shell remains bounded on 4K', async ({ page }) => {
    await setupViewportFixtures(page)
    await page.goto('/settings/config')
    await expect(page.getByTestId('settings-config-heading')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expect(page).toHaveScreenshot('plan-269-viewport-desktop-4k-settings.png')
  })
})

test.describe('PLAN-269 viewport matrix: desktop-2k', () => {
  test.use({ viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 1 })

  test('workspace shell remains bounded on 2K', async ({ page }) => {
    await setupViewportFixtures(page)
    await page.goto('/workspace/workspace-1')
    await expect(page.getByTestId('workspace-toolbar-settings')).toBeVisible()
    await expect(page.getByText('从文件树选择文件')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expect(page).toHaveScreenshot('plan-269-viewport-desktop-2k-workspace.png')
  })
})

test.describe('PLAN-269 viewport matrix: desktop-1080p', () => {
  test.use({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })

  test('chat composer and sidebar remain usable at 1080p', async ({ page }) => {
    await setupViewportFixtures(page)
    await page.goto('/chat/session-1')
    await expect(page.getByTestId('chat-input')).toBeVisible()
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expect(page).toHaveScreenshot('plan-269-viewport-desktop-1080p-chat.png')
  })
})

test.describe('PLAN-269 viewport matrix: desktop-720p', () => {
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 })

  test('workspace toolbar and composer remain usable at 720p', async ({ page }) => {
    await setupViewportFixtures(page)
    await page.goto('/workspace/workspace-1')
    await expect(page.getByTestId('workspace-toolbar-settings')).toBeVisible()
    await expect(page.getByTestId('chat-input')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expect(page).toHaveScreenshot('plan-269-viewport-desktop-720p-workspace.png')
  })
})

test.describe('PLAN-269 viewport matrix: mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  test('Files and Chat sheets remain bounded on mobile', async ({ page }) => {
    await setupViewportFixtures(page)
    await page.goto('/workspace/workspace-1')
    await page.getByRole('button', { name: 'Files' }).click()
    const filesSheet = page.getByTestId('mobile-files-sheet')
    await expect(filesSheet).toBeVisible()
    await expect(filesSheet.getByTestId('workspace-empty-state')).toBeVisible()
    await expect(filesSheet).toHaveScreenshot('plan-269-viewport-mobile-files.png')
    await page.getByRole('button', { name: /close/i }).last().click()
    await page.getByRole('button', { name: 'Open chat' }).click()
    await expect(page.getByTestId('mobile-chat-sheet')).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await expect(page.getByTestId('mobile-chat-sheet')).toHaveScreenshot('plan-269-viewport-mobile-chat.png')
  })
})
