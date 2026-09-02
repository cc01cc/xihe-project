import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('@host Workspace — File Panel & Delete Flow', () => {
  let authToken = ''
  let wsId = ''

  test.beforeAll(async ({ request }) => {
    const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `ws-ui-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: 'WsUI' },
    })
    const auth = await r.json()
    authToken = auth.accessToken
    wsId = auth.workspaceId

    const mcpHeaders = {
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'X-Workspace-Id': wsId,
    }
    const init = await request.post(`${CP_URL}/api/v1/mcp`, {
      headers: mcpHeaders,
      data: {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'xihe-e2e', version: '0.1.0' } },
      },
    })
    expect(init.status(), `initialize failed: ${init.status()} ${await init.text()}`).toBe(200)
    const sessionId = init.headers()['mcp-session-id']

    const sessionHeaders = sessionId ? { ...mcpHeaders, 'mcp-session-id': sessionId } : mcpHeaders
    if (sessionId) {
      await request.post(`${CP_URL}/api/v1/mcp`, {
        headers: sessionHeaders,
        data: { jsonrpc: '2.0', method: 'notifications/initialized' },
      })
    }

    const list = await request.post(`${CP_URL}/api/v1/mcp`, {
      headers: sessionHeaders,
      data: { jsonrpc: '2.0', method: 'tools/list', id: 2, params: {} },
    })
    const listText = await list.text()
    expect(list.status(), `tools/list failed: ${list.status()} ${listText}`).toBe(200)
    expect(listText, `runtime__write_file missing from tools/list: ${listText}`).toContain('write_file')

    const write = await request.post(`${CP_URL}/api/v1/mcp`, {
      headers: sessionHeaders,
      data: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 3,
        params: { name: 'write_file', arguments: { path: 'e2e-note.md', content: '# E2E Note\n\nSeeded by workspace-files spec.' } },
      },
    })
    const writeText = await write.text()
    expect(write.status(), `seed write_file failed: ${write.status()} ${writeText}`).toBe(200)
    expect(writeText, `write_file returned error: ${writeText}`).not.toContain('"error"')
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
    await page.addInitScript((raw) => localStorage.setItem('xihe-user', raw), JSON.stringify({ workspaceId: wsId }))
  })

  test('seeded file appears in panel and opens in editor without layout collapse', async ({ page }) => {
    const mcpBodies: string[] = []
    page.on('response', (res) => {
      if (res.url().includes('/api/v1/mcp')) {
        res.text().then((t) => mcpBodies.push(`${res.status()} ${t.slice(0, 300)}`)).catch(() => {})
      }
    })
    await page.goto('/workspace', { waitUntil: 'load' })

    const fileEntry = page.locator('text=e2e-note.md').first()
    try {
      await expect(fileEntry).toBeVisible({ timeout: 15000 })
    } catch {
      await page.waitForTimeout(500)
      throw new Error(`seeded file not visible; mcp responses: ${mcpBodies.join(' || ')}`)
    }
    await fileEntry.click()
    await page.waitForTimeout(1500)

    await expect(page.locator('text=E2E Note').first()).toBeVisible({ timeout: 10000 })
    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement
      return doc ? doc.scrollWidth - doc.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(2)
    await expect(page).toHaveScreenshot('workspace-file-selected.png')
  })

  test('file delete confirm dialog renders destructive action with correct layering', async ({ page }) => {
    await page.goto('/workspace', { waitUntil: 'load' })
    const fileEntry = page.locator('text=e2e-note.md').first()
    await expect(fileEntry).toBeVisible({ timeout: 15000 })

    await fileEntry.click({ button: 'right' })
    const deleteItem = page.getByRole('button', { name: /^Delete$|^删除$/ }).first()
    await expect(deleteItem).toBeVisible({ timeout: 8000 })
    await deleteItem.click()

    const dialog = page.locator('[data-testid="modal-backdrop"]').first()
    await expect(dialog).toBeVisible({ timeout: 8000 })
    const destructiveBtn = dialog.locator('button').filter({ hasText: /delete|删除|confirm|确认/i }).first()
    await expect(destructiveBtn).toBeVisible()

    const color = await destructiveBtn.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(color).not.toBe('rgba(0, 0, 0, 0)')
    const hit = await destructiveBtn.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return top === el || el.contains(top)
    })
    expect(hit).toBe(true)
    await expect(page).toHaveScreenshot('workspace-delete-dialog.png')
  })

  test('workspace empty state is centered and styled', async ({ page, request }) => {
    const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `ws-empty-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: 'WsEmpty' },
    })
    const token = (await r.json()).accessToken
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)
    await page.goto('/workspace', { waitUntil: 'load' })
    await page.waitForTimeout(1500)
    await expect(page).toHaveScreenshot('workspace-empty-state.png')
  })
})

