import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { generateE2EPassword } from './helpers/password'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()

type Auth = {
  accessToken: string
  workspaceId: string
}

async function register(request: APIRequestContext, name: string): Promise<Auth> {
  const email = `${name}-${Date.now()}@test.local`
  const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
    data: { email, password: SHARED_PASSWORD, name },
  })
  expect(response.status(), await response.text()).toBe(201)
  const body = await response.json()
  return { accessToken: body.accessToken, workspaceId: body.workspaceId }
}

async function installAuth(page: Page, auth: Auth) {
  await page.addInitScript(({ token, workspaceId }) => {
    localStorage.setItem('xihe-token', token)
    localStorage.setItem('xihe-user', JSON.stringify({ workspaceId }))
    localStorage.setItem('xihe-workspace', JSON.stringify({ id: workspaceId, name: 'Default Workspace' }))
  }, { token: auth.accessToken, workspaceId: auth.workspaceId })
}

function mcpHeaders(auth: Auth): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'X-Workspace-Id': auth.workspaceId,
  }
}

async function callMcp(request: APIRequestContext, auth: Auth, name: string, args: Record<string, unknown>) {
  const response = await request.post(`${CP_URL}/api/v1/mcp`, {
    headers: mcpHeaders(auth),
    data: {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: Date.now(),
      params: { name, arguments: args },
    },
  })
  const text = await response.text()
  expect(response.status(), text).toBe(200)
  const line = text.split('\n').find((value) => value.startsWith('data:'))?.slice(5).trim() ?? text
  return JSON.parse(line) as { result?: { content?: Array<{ text?: string }> } }
}

test.describe('@host PLAN-269 full UI acceptance: real core flows', () => {
  test('real session rename and delete are visible in the sidebar', async ({ page, request }) => {
    const auth = await register(request, 'session-lifecycle')
    await installAuth(page, auth)
    await page.goto('/chat')

    const session = page.getByTestId('session-item').first()
    await expect(session).toBeVisible({ timeout: 15000 })
    await session.click({ button: 'right' })
    await page.getByRole('button', { name: '重命名' }).click()
    const renameInput = session.locator('input')
    await renameInput.fill('真实流程会话')
    await renameInput.press('Enter')
    await expect(page.getByTestId('session-item').filter({ hasText: '真实流程会话' })).toBeVisible({ timeout: 10000 })

    await page.getByTestId('session-item').filter({ hasText: '真实流程会话' }).click({ button: 'right' })
    await page.getByRole('button', { name: '删除' }).click()
    await expect(page.getByTestId('session-item').filter({ hasText: '真实流程会话' })).not.toBeVisible({ timeout: 10000 })
    await expect(page).toHaveScreenshot('plan-269-real-session-deleted-current.png')
  })

  test('real workspace editor saves content through the UI path', async ({ page, request }) => {
    const auth = await register(request, 'workspace-editor')
    await callMcp(request, auth, 'write_file', {
      path: 'acceptance.md',
      content: '# Acceptance\n\nOriginal content',
    })
    await installAuth(page, auth)
    await page.goto(`/workspace/${auth.workspaceId}`)

    const file = page.getByRole('button', { name: 'acceptance.md', exact: true })
    await expect(file).toBeVisible({ timeout: 15000 })
    await file.click()
    await expect(page.getByText('Acceptance', { exact: false }).first()).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: '源码' }).click()
    const source = page.getByTestId('workspace-markdown-source')
    await source.fill('# Acceptance\n\nChanged through UI')
    const save = page.getByRole('button', { name: '保存', exact: true })
    await expect(save).toBeEnabled()
    await save.click()
    await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible()

    const read = await callMcp(request, auth, 'read_file', { path: 'acceptance.md' })
    expect(read.result?.content?.[0]?.text).toContain('Changed through UI')
    await expect(page).toHaveScreenshot('plan-269-real-workspace-editor-saved-current.png')
  })

  test('real workspace Prepare transitions from unbound to ready', async ({ page, request }) => {
    const auth = await register(request, 'workspace-environment')
    await installAuth(page, auth)
    await page.goto(`/workspace/${auth.workspaceId}/environment`)
    await expect(page.getByTestId('workspace-environment-status')).toContainText('unbound', { timeout: 15000 })
    await page.getByTestId('workspace-prepare-button').click()
    await expect(page.getByTestId('workspace-environment-status')).toContainText('ready', { timeout: 90000 })
    await expect(page).toHaveScreenshot('plan-269-real-environment-ready-current.png')
  })

  test('real workspace upload makes a file visible in the tree', async ({ page, request }) => {
    const auth = await register(request, 'workspace-upload')
    await installAuth(page, auth)
    await page.goto(`/workspace/${auth.workspaceId}`)
    await page.getByRole('button', { name: 'Upload files' }).click()
    const dialog = page.getByTestId('workspace-import-dialog')
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'uploaded.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Uploaded\n\nCreated by the UI acceptance flow.'),
    })
    await expect(page.getByText('uploaded.md', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: '导入' }).click()
    await expect(page.getByRole('button', { name: 'uploaded.md', exact: true })).toBeVisible({ timeout: 15000 })
    await expect(page).toHaveScreenshot('plan-269-real-workspace-uploaded-current.png')
  })

  test('real ProviderHub exposes live catalog and connection form', async ({ page, request }) => {
    const auth = await register(request, 'provider-hub')
    await installAuth(page, auth)
    await page.goto('/settings/config')
    const hub = page.getByTestId('provider-hub')
    await expect(hub).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('provider-hub-connect')).toBeEnabled({ timeout: 15000 })
    await page.getByTestId('provider-hub-connect').click()
    await expect(page.getByTestId('provider-picker-modal')).toBeVisible()
    await expect(page.getByTestId('provider-picker-search')).toBeVisible()
    await page.getByTestId('provider-picker-search').fill('open')
    await expect(page.locator('button[data-testid^="provider-picker-"]').first()).toBeVisible()
    await expect(page).toHaveScreenshot('plan-269-real-provider-picker-current.png')
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.getByTestId('provider-picker-modal')).not.toBeVisible()
  })
})

test.describe('@host PLAN-269 full UI acceptance: real mobile flows', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })

  test('real mobile Files and Chat Sheets open and close without overflow', async ({ page, request }, testInfo) => {
    const auth = await register(request, 'mobile-sheets')
    await installAuth(page, auth)
    await page.goto(`/workspace/${auth.workspaceId}`)
    await page.reload()

    await page.getByRole('button', { name: 'Files' }).click()
    const filesSheet = page.getByTestId('mobile-files-sheet')
    await expect(filesSheet).toBeVisible()
    await expect(filesSheet.getByTestId('workspace-empty-state')).toBeVisible({ timeout: 15000 })
    await expect(filesSheet.getByText('工作区暂无文件')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('plan-269-real-mobile-files-full.png') })
    await expect(filesSheet).toHaveScreenshot('plan-269-real-mobile-files-sheet-empty.png')
    await page.getByRole('button', { name: /close/i }).last().click()
    await page.getByRole('button', { name: 'Open chat' }).click()
    await expect(page.getByTestId('mobile-chat-sheet')).toBeVisible()

    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement
      return doc ? doc.scrollWidth - doc.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(2)
    await expect(page).toHaveScreenshot('plan-269-real-mobile-chat-sheet-current.png')
  })
})
