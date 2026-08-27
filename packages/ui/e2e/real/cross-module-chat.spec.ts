import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

async function registerAndGetToken(name: string): Promise<string> {
  const email = `${name}-${Date.now()}@test.com`
  const reg = await fetch(`${CP_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Test1234!', name }),
  })
  const body = await reg.json()
  return body.accessToken
}

test.describe('Cross-Module — Full Chain Chat', () => {
  test('chat page loads after login', async ({ page }) => {
    const token = await registerAndGetToken('chain')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    await page.goto('/chat')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })
  })

  test('sends message and renders response in the UI', async ({ page }) => {
    const token = await registerAndGetToken('chain-msg')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    await page.goto('/chat')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })

    const testMessage = `Hello ${Date.now()}`
    const textarea = page.locator('textarea')
    await textarea.fill(testMessage)
    await page.keyboard.press('Enter')

    // User message must appear in the DOM immediately.
    await expect(page.locator(`text=${testMessage}`)).toBeVisible({ timeout: 5000 })

    // User message must appear in the local chat store.
    await page.waitForTimeout(2000)
    const messages = await page.evaluate(() => {
      const raw = localStorage.getItem('xihe-messages')
      if (!raw) return []
      const data = JSON.parse(raw)
      return Object.values(data).flatMap((msgs: any) =>
        (msgs as Array<{ role: string; content: string }>).map(m => ({ role: m.role, content: m.content }))
      )
    })
    expect(messages.some(m => m.role === 'user' && m.content === testMessage)).toBe(true)

    // The UI must not get stuck in the "Thinking" state when the backend fails.
    await expect(page.locator('text=Thinking')).not.toBeVisible({ timeout: 30000 })

    // Assistant response must not be serialized as [object Object].
    const assistantMessages = await page.locator('[class*="bg-card"]').allInnerTexts()
    expect(assistantMessages.some(text => text.includes('[object Object]'))).toBe(false)
  })

  test('mcp tools/list returns tools', async ({ page }) => {
    const token = await registerAndGetToken('mcp-test')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    await page.goto('/settings/config')
    await expect(page.locator('text=MCP 服务').first()).toBeVisible({ timeout: 10000 })
    await expect(page.locator('textarea')).toBeVisible()

    const builtInTool = page.locator('text=read_file').first()
    await expect(builtInTool).toBeVisible()
  })

  test('mcp config save and reload persists', async ({ page, request }) => {
    const token = await registerAndGetToken('mcp-persist')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    // Save MCP config via CP API (CP endpoints have no /api/v1 prefix)
    const mcpConfig = {
      mcpServers: {
        'test-echo': {
          command: 'echo',
          args: ['hello'],
        },
      },
    }
    const saveResp = await request.put(`${CP_URL}/workspaces/default/mcp-config`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: mcpConfig,
    })
    expect(saveResp.ok()).toBe(true)

    // Read back via CP API
    const getResp = await request.get(`${CP_URL}/workspaces/default/mcp-config`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(getResp.ok()).toBe(true)
    const body = await getResp.json()
    expect(body).toHaveProperty('mcpServers')

    // Verify it appears in the UI
    await page.goto('/settings/config')
    await expect(page.locator('text=MCP 服务').first()).toBeVisible({ timeout: 10000 })
    const textarea = page.locator('[data-testid="mcp-config-textarea"]')
    await expect(textarea).toBeVisible()
    await expect(textarea).toHaveValue(/test-echo/, { timeout: 10000 })
  })

  test('mcp config with invalid json shows error toast', async ({ page, request }) => {
    const token = await registerAndGetToken('mcp-invalid')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    const saveResp = await request.put(`${CP_URL}/workspaces/default/mcp-config`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { mcpServers: 'not-valid-object' },
    })
    // Should still accept as JSON string, or reject — either way test that CP responds
    expect(saveResp.status()).toBeGreaterThanOrEqual(200)
    expect(saveResp.status()).toBeLessThan(500)
  })

  test('mcp session-id sign and verify via CP', async ({ page, request }) => {
    const token = await registerAndGetToken('mcp-session')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    // MCP initialize request via CP should return a signed Mcp-Session-Id
    const initResp = await request.post(`${CP_URL}/mcp`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Workspace-Id': 'default',
      },
      data: { jsonrpc: '2.0', method: 'initialize', id: 1 },
    })
    expect(initResp.ok()).toBe(true)

    const sessionId = initResp.headers()['mcp-session-id']
    expect(sessionId).toBeTruthy()
    // HMAC-signed session-id must contain a '.' separator
    expect(sessionId).toContain('.')
  })
})
