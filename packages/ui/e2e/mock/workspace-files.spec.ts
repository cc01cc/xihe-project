import { test, expect } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

const TREE_ENTRIES = [
  { name: 'src', type: 'directory' },
  { name: 'notes.md', type: 'file', size: 12 },
  { name: 'Makefile', type: 'file', size: 40 },
]

test.describe('Workspace file operations (PLAN-262 M3)', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, {
      sessions: [{ id: 'session-1', title: 'Session 1' }],
      messages: { 'session-1': [] },
    })
    await page.route('**/mcp', async (route) => {
      const body = route.request().postDataJSON() as {
        method?: string
        params?: { name?: string; arguments?: Record<string, unknown> }
      }
      const tool = body?.params?.name ?? ''
      if (body?.method !== 'tools/call') {
        await route.fallback()
        return
      }
      if (tool === 'list_directory') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries: TREE_ENTRIES } }),
        })
        return
      }
      if (tool === 'read_file') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: 'hello' } }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { message: 'ok' } }),
      })
    })
    // Environment endpoint for the five-state view
    await page.route('**/api/v1/workspaces/*/environment', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workspaceId: 'workspace-1',
          status: 'ready',
          storageBackend: 'host_directory',
          storageRef: 'workspace-1',
          executionSpec: { status: 'assigned', generation: 1, sandboxSpecHash: 'abc' },
          runtime: { status: 'observed', deviceId: 'dev-1', lastHeartbeatAt: 'now' },
        }),
      })
    })
  })

  test('tree search filters and highlights (mock tree entries)', async ({ page }) => {
    // Seed the file tree directly: the real list_directory chain goes through
    // CP+MCP and is covered by host E2E; here we verify search/filter/highlight.
    await page.addInitScript(() => {
      const tree = [
        { name: 'src', path: 'src', type: 'directory', children: [] },
        { name: 'notes.md', path: 'notes.md', type: 'file', size: 12 },
        { name: 'Makefile', path: 'Makefile', type: 'file', size: 40 },
      ]
      localStorage.setItem('xihe-mock-filetree', JSON.stringify(tree))
    })
    await page.goto('/workspace/workspace-1')
    await expect(page.getByText('notes.md')).toBeVisible({ timeout: 15000 })

    const search = page.getByPlaceholder('过滤文件树')
    await search.fill('note')
    await expect(page.getByText('notes.md')).toBeVisible()
    await expect(page.getByText('Makefile')).not.toBeVisible()

    await search.fill('')
    await expect(page.getByText('Makefile')).toBeVisible()
  })

  test('environment page shows five-state pill, storage access and refresh', async ({ page }) => {
    await page.goto('/workspace/workspace-1/environment')
    await expect(page.getByTestId('workspace-environment-heading')).toBeVisible()
    await expect(page.getByTestId('workspace-environment-status')).toContainText('ready')
    await expect(page.getByTestId('workspace-environment-recovery')).not.toBeEmpty()
    await expect(page.getByText('系统文件操作直访')).toBeVisible()
  })

  test('blocked environment shows recovery guidance and prepare card states', async ({ page }) => {
    await page.route('**/api/v1/workspaces/*/environment', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workspaceId: 'workspace-1',
          status: 'blocked',
          storageBackend: 'host_directory',
          storageRef: 'workspace-1',
          executionSpec: { status: 'assigned', generation: 1, sandboxSpecHash: 'abc' },
          runtime: { status: 'blocked', deviceId: 'dev-1', lastHeartbeatAt: 'now' },
        }),
      })
    })
    await page.route('**/api/v1/workspaces/*/materialize', async (route) => {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'materializing' }),
      })
    })
    await page.goto('/workspace/workspace-1/environment')
    await expect(page.getByTestId('workspace-environment-status')).toContainText('blocked')
    await expect(page.getByTestId('workspace-prepare-card')).toBeVisible()
    await page.getByTestId('workspace-prepare-button').click()
    await expect(page.getByTestId('workspace-prepare-button')).toContainText('Preparing')
  })
})
