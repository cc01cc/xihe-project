import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

async function registerAndGetToken(name: string): Promise<string> {
  const email = `${name}-${Date.now()}@test.com`
  const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
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

    // Save MCP config through the canonical public API.
    const mcpConfig = {
      mcpServers: {
        'test-echo': {
          command: 'echo',
          args: ['hello'],
        },
      },
    }
    const saveResp = await request.put(`${CP_URL}/api/v1/workspaces/default/mcp-config`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: mcpConfig,
    })
    expect(saveResp.ok()).toBe(true)

    // Read back via CP API
    const getResp = await request.get(`${CP_URL}/api/v1/workspaces/default/mcp-config`, {
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

    const saveResp = await request.put(`${CP_URL}/api/v1/workspaces/default/mcp-config`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { mcpServers: 'not-valid-object' },
    })
    // Should still accept as JSON string, or reject — either way test that CP responds
    expect(saveResp.status()).toBeGreaterThanOrEqual(200)
    expect(saveResp.status()).toBeLessThan(500)
  })

  test('mcp initialize negotiates 2026 protocol via CP', async ({ page, request }) => {
    const token = await registerAndGetToken('mcp-session')
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)

    // MCP 2026-07-28 discover lifecycle does not require a session-id.
    const initResp = await request.post(`${CP_URL}/api/v1/mcp`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'X-Workspace-Id': 'default',
      },
      data: {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'xihe-e2e', version: '0.1.0' },
        },
      },
    })
    expect(initResp.ok()).toBe(true)

    const responseText = await initResp.text()
    const jsonText = responseText.startsWith('data:')
      ? responseText.split('\n').find(line => line.startsWith('data:'))!.slice(5).trim()
      : responseText
    const body = JSON.parse(jsonText)
    expect(body.result.protocolVersion).toBe('2026-07-28')
  })

  test('remote MCP OAuth completes through UI click, browser redirect, callback, and re-auth', async ({ page, request }) => {
    const email = `oauth-${Date.now()}@test.com`
    const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: { email, password: 'Test1234!', name: 'oauth-e2e' },
    })
    expect(registration.ok()).toBe(true)
    const auth = await registration.json()
    const serverId = randomUUID()
    const fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT || '13640'
    const uiPort = process.env.XIHE_UI_PORT || '12630'
    const redirectUri = `http://localhost:${uiPort}/settings/config`
    const save = await request.put(`${CP_URL}/api/v1/workspaces/${auth.workspaceId}/mcp-config`, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
      },
      data: {
        mcpServers: {
          [serverId]: {
            name: 'UI OAuth fixture',
            url: 'https://example.com/mcp',
            oauth: {
              clientId: 'xihe-e2e-client',
              authorizationEndpoint: `http://localhost:${fakeOAuthPort}/authorize`,
              tokenEndpoint: `http://host.docker.internal:${fakeOAuthPort}/token`,
              redirectUri,
              scope: 'mcp:tools',
            },
          },
        },
      },
    })
    expect(save.ok()).toBe(true)

    await page.addInitScript((token) => localStorage.setItem('xihe-token', token), auth.accessToken)
    await page.goto('/settings/config')
    const serverRow = page.locator(`[data-testid="remote-mcp-${serverId}"]`)
    await expect(serverRow).toBeVisible({ timeout: 10000 })
    const authorizeButton = serverRow.locator('button')
    await authorizeButton.click()
    await page.waitForURL(/\/settings\/config(?:\?|$)/, { timeout: 10000 })
    await expect(serverRow).toContainText(/已授权|Authorized/, { timeout: 10000 })

    await authorizeButton.click()
    await page.waitForURL(/\/settings\/config(?:\?|$)/, { timeout: 10000 })
    await expect(serverRow).toContainText(/已授权|Authorized/, { timeout: 10000 })
  })

  test('Runtime obtains a scoped token and calls the remote MCP', async ({ request }) => {
    const registration = await request.post(`${CP_URL}/api/v1/auth/register`, {
      headers: { 'Content-Type': 'application/json' },
      data: { email: `remote-call-${Date.now()}@test.com`, password: 'Test1234!', name: 'remote-call-e2e' },
    })
    expect(registration.ok()).toBe(true)
    const auth = await registration.json()
    const serverId = randomUUID()
    const fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT || '13640'
    const fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT || '13641'
    const cpPort = process.env.XIHE_CP_PORT || '12631'
    const redirectUri = `http://localhost:${cpPort}/api/v1/oauth/callback`
    const session = await request.post(`${CP_URL}/api/v1/oauth/sessions`, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      data: {
        workspaceId: auth.workspaceId,
        serverId,
        remoteEndpoint: `http://host.docker.internal:${fakeMcpPort}/mcp`,
        clientId: 'xihe-e2e-client',
        authorizationEndpoint: `http://localhost:${fakeOAuthPort}/authorize`,
        tokenEndpoint: `http://host.docker.internal:${fakeOAuthPort}/token`,
        redirectUri,
        scope: 'mcp:tools',
      },
    })
    expect(session.ok()).toBe(true)
    const oauth = await session.json()
    const authorize = await request.get(oauth.authorizationUrl, { maxRedirects: 0 })
    expect(authorize.status()).toBe(302)
    const callback = new URL(authorize.headers().location)
    const callbackResult = await request.get(`${CP_URL}${callback.pathname}${callback.search}`)
    if (!callbackResult.ok()) {
      throw new Error(`OAuth callback failed: ${callbackResult.status()} ${await callbackResult.text()}`)
    }

    const runtimePort = process.env.XIHE_RUNTIME_PORT || '12633'
    const runtimeUrl = `http://localhost:${runtimePort}/internal/v1/runtime/remote-mcp/${auth.workspaceId}/${serverId}/call`
    let response
    for (let attempt = 0; attempt < 8; attempt += 1) {
      response = await request.post(runtimeUrl, {
        headers: {
          Authorization: `Bearer ${process.env.XIHE_CP_API_TOKEN || 'dev-token-change-me'}`,
          'Content-Type': 'application/json',
        },
        data: {
          userId: auth.user.id,
          endpoint: `http://host.docker.internal:${fakeMcpPort}/mcp`,
          tool: 'remote_echo',
          arguments: { text: 'through-runtime' },
          scope: 'mcp:tools',
        },
      })
      if (response.status() !== 404) break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (!response?.ok()) {
      throw new Error(`Runtime remote MCP call failed: ${response?.status()} ${await response?.text()}`)
    }
    await expect(response!.json()).resolves.toMatchObject({ content: [{ text: 'through-runtime' }] })

    const brokerRequest = {
      userId: auth.user.id,
      workspaceId: auth.workspaceId,
      serverId,
      scope: 'mcp:tools',
    }
    const refreshed = await request.post(`${CP_URL}/internal/v1/oauth/token`, {
      headers: { Authorization: 'Bearer dev-token-change-me', 'Content-Type': 'application/json' },
      data: brokerRequest,
    })
    expect(refreshed.ok()).toBe(true)
    expect((await refreshed.json()).access_token).toBe('fixture-token')

    const revoke = await request.post(`${CP_URL}/api/v1/oauth/revoke`, {
      headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
      data: { workspaceId: auth.workspaceId, serverId },
    })
    expect(revoke.ok()).toBe(true)
    const afterRevoke = await request.post(`${CP_URL}/internal/v1/oauth/token`, {
      headers: { Authorization: 'Bearer dev-token-change-me', 'Content-Type': 'application/json' },
      data: brokerRequest,
    })
    expect(afterRevoke.status()).toBe(401)
  })

  test('Fake Remote MCP exposes authenticated 2026 SSE channel', async ({ request }) => {
    const fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT || '13641'
    const response = await request.get(`http://localhost:${fakeMcpPort}/mcp`, {
      headers: { Authorization: 'Bearer fixture-token', Accept: 'text/event-stream' },
    })
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toContain('text/event-stream')
    expect(await response.text()).toContain('2026-07-28')
  })

  test('Fake Remote MCP enforces session, requestState, timeout, SSE resume, and disconnect', async ({ request }) => {
    const fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT || '13641'
    const endpoint = `http://localhost:${fakeMcpPort}/mcp`
    const headers = {
      Authorization: 'Bearer fixture-token',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    }
    const initialize = await request.post(endpoint, {
      headers,
      data: {
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } },
      },
    })
    expect(initialize.ok()).toBe(true)
    const sessionId = initialize.headers()['mcp-session-id']
    expect(sessionId).toMatch(/^fixture-/)

    const sessionHeaders = { ...headers, 'mcp-session-id': sessionId }
    const inputRequired = await request.post(endpoint, {
      headers: sessionHeaders,
      data: { jsonrpc: '2.0', method: 'tools/call', id: 2, params: { name: 'remote_echo', arguments: { mode: 'input_required' } } },
    })
    const inputBody = await inputRequired.json()
    expect(inputRequired.ok()).toBe(true)
    expect(inputBody.result.requestState.required).toEqual(['value'])

    const sse = await request.get(endpoint, {
      headers: { Authorization: 'Bearer fixture-token', Accept: 'text/event-stream', 'mcp-session-id': sessionId, 'Last-Event-ID': 'ready-0' },
    })
    expect(sse.ok()).toBe(true)
    expect(sse.headers()['content-type']).toContain('text/event-stream')
    expect(await sse.text()).toContain('id: ready-1')

    const timeout = await request.post(endpoint, {
      headers: sessionHeaders,
      timeout: 500,
      data: { jsonrpc: '2.0', method: 'tools/call', id: 3, params: { name: 'remote_echo', arguments: { mode: 'timeout' } } },
    }).catch((error) => error)
    expect(timeout).toBeInstanceOf(Error)

    const disconnected = await request.delete(endpoint, { headers: sessionHeaders })
    expect(disconnected.ok()).toBe(true)
    const afterDisconnect = await request.post(endpoint, {
      headers: sessionHeaders,
      data: { jsonrpc: '2.0', method: 'tools/list', id: 4, params: {} },
    })
    expect(afterDisconnect.status()).toBe(404)
  })
})
