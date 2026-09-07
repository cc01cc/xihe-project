import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

const providerCatalog = {
  catalogRevision: 'mock-revision',
  providers: [
    {
      id: 'openai',
      displayName: 'OpenAI',
      category: 'recommended',
      description: 'OpenAI-compatible provider',
      adapter: 'openai-compatible',
      defaultBaseUrl: 'https://api.openai.com/v1',
      modelDiscovery: 'remote-models',
      credential: { type: 'api-key', required: true, placeholder: 'sk-test' },
      supports: { customBaseUrl: true, streaming: true, tools: true, vision: true },
    },
    {
      id: 'local',
      displayName: 'Local model',
      category: 'custom',
      description: 'Local manual model',
      adapter: 'manual-model',
      modelDiscovery: 'manual',
      credential: { type: 'none', required: false },
      supports: { customBaseUrl: false, streaming: false },
    },
  ],
}

async function mockSettingsApis(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/events**', (route) => route.fulfill({
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    body: 'retry: 5000\n\n',
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
  await page.route('**/api/v1/config/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ logLevel: 'info', defaultProvider: 'openai', defaultModel: 'gpt-test' }),
  }))
  await page.route('**/api/v1/workspaces/*/mcp-config', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mcpServers: {} }),
  }))
  await page.route('**/api/v1/workspaces/*/environment', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      workspaceId: 'workspace-1',
      status: 'ready',
      storageBackend: 'host_directory',
      storageRef: 'workspace-1',
      executionSpec: { status: 'assigned', generation: 1, sandboxSpecHash: 'spec' },
      runtime: { status: 'ready', deviceId: 'device-1', lastHeartbeatAt: 'now' },
    }),
  }))
  await page.route('**/api/v1/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'healthy',
      timestamp: Date.now(),
      services: [{ name: 'Control Plane', key: 'control-plane', status: 'up', responseMs: 5 }],
    }),
  }))
  await page.route('**/api/v1/rag/stats', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ documents: [] }),
  }))
  await page.route('**/api/v1/provider-catalog', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(providerCatalog),
  }))
  await page.route('**/api/v1/provider-connections', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ connections: [] }),
  }))
}

test.describe('PLAN-269 full UI acceptance: routes and auth', () => {
  test('protected route matrix reaches each current page', async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Session 1' }] })
    await mockSettingsApis(page)

    const routes = [
      { path: '/chat/session-1', marker: page.locator('textarea') },
      { path: '/settings/config', marker: page.getByTestId('settings-config-heading') },
      { path: '/settings/knowledge', marker: page.getByTestId('settings-knowledge-heading') },
      { path: '/settings/data', marker: page.getByTestId('settings-data-heading') },
      { path: '/settings/monitoring', marker: page.getByTestId('settings-monitoring-heading') },
      { path: '/workspace/workspace-1', marker: page.getByTestId('workspace-toolbar-settings') },
      { path: '/workspace/workspace-1/environment', marker: page.getByTestId('workspace-environment-heading') },
    ]

    for (const [index, route] of routes.entries()) {
      await page.goto(route.path, { waitUntil: 'load' })
      await expect(route.marker).toBeVisible({ timeout: 10000 })
      expect(page.url()).toContain(route.path)
      await expect(page).toHaveScreenshot(`plan-269-route-${index + 1}.png`)
    }
  })

  test('Sidebar navigation updates route and active state', async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Session 1' }] })
    await mockSettingsApis(page)

    await page.goto('/chat/session-1')
    await page.getByTestId('sidebar-workspace').click()
    await expect(page).toHaveURL(/\/workspace\/workspace-1$/)
    await expect(page.getByTestId('sidebar-workspace')).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('workspace-toolbar-settings')).toBeVisible()

    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page).toHaveURL(/\/settings\/config$/)
    await expect(page.getByTestId('settings-config-heading')).toBeVisible()
    await expect(page).toHaveScreenshot('plan-269-sidebar-settings-navigation.png')
  })

  test('invalid login keeps the form and renders a user-safe error', async ({ page }) => {
    await page.route('**/api/v1/auth/login', (route) => route.fulfill({
      status: 401,
      contentType: 'application/problem+json',
      body: JSON.stringify({ code: 'INVALID_CREDENTIALS', detail: 'Invalid credentials' }),
    }))
    await page.goto('/login')
    await page.getByLabel('邮箱/用户名').fill('wrong@xihe.local')
    await page.getByLabel('密码').fill('wrong-password')
    await page.getByRole('button', { name: '登录' }).click()
    await expect(page.locator('p.text-destructive')).toBeVisible()
    await expect(page.locator('p.text-destructive')).not.toContainText('[object Object]')
    await expect(page).toHaveScreenshot('plan-269-login-error.png')
  })

  test('registration mismatch disables submit and shows inline validation', async ({ page }) => {
    await page.goto('/register')
    await page.locator('#email').fill('new-user@xihe.local')
    await page.locator('#password').fill('correct-password')
    await page.locator('#confirmPassword').fill('different-password')
    await expect(page.getByText('两次输入的密码不一致')).toBeVisible()
    await expect(page.locator('button[type="submit"]')).toBeDisabled()
    await expect(page).toHaveScreenshot('plan-269-register-mismatch.png')
  })

  test('message search is reachable and filters persisted messages', async ({ page }, testInfo) => {
    await setupMockAuth(page)
    await setupMockSessions(page, {
      sessions: [{ id: 'session-search', title: 'Search session' }],
      messages: {
        'session-search': [
          { id: 'message-1', sessionId: 'session-search', role: 'USER', content: 'keep this result' },
          { id: 'message-2', sessionId: 'session-search', role: 'ASSISTANT', content: 'hide this message' },
        ],
      },
    })
    await page.goto('/chat/session-search')
    await expect(page.getByText('keep this result')).toBeVisible()
    await page.getByTestId('message-search-toggle').click()
    await page.getByPlaceholder('搜索消息…').fill('keep')
    const result = page.getByText('keep this result').first()
    await expect(result).toBeVisible()
    await result.scrollIntoViewIfNeeded()
    await expect(result).toBeInViewport()
    await expect(page.locator('[data-slot="message-scroller-content"]')).toHaveCSS('padding-top', '48px')
    await result.locator('..').screenshot({ path: testInfo.outputPath('plan-269-message-search-result.png') })
    await page.screenshot({ path: testInfo.outputPath('plan-269-message-search-full.png') })
    await expect(page.getByText('hide this message')).not.toBeVisible()
    await expect(page.getByTestId('message-list')).toHaveScreenshot('plan-269-message-search.png')
    await page.screenshot({ path: testInfo.outputPath('plan-269-message-search-after.png') })
  })
})

test.describe('PLAN-269 full UI acceptance: settings and provider', () => {
  test('ProviderHub creates, verifies, manages and deletes a connection', async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Session 1' }] })
    await mockSettingsApis(page)
    let connection: Record<string, unknown> | null = null

    await page.unroute('**/api/v1/provider-connections')
    await page.route('**/api/v1/provider-connections', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connections: connection ? [connection] : [] }) })
        return
      }
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as Record<string, unknown>
        connection = {
          id: 'connection-1', providerId: body.providerId, label: body.label, scope: body.scope,
          hasKey: true, maskedKey: 'sk-••••', enabled: true, status: 'UNVERIFIED', revision: 1,
        }
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(connection) })
        return
      }
      await route.fallback()
    })
    await page.route('**/api/v1/provider-connections/*', async (route) => {
      if (route.request().method() === 'DELETE') {
        connection = null
        await route.fulfill({ status: 204, body: '' })
        return
      }
      await route.fallback()
    })
    await page.route('**/api/v1/provider-connections/*/verify', async (route) => {
      connection = { ...connection, status: 'READY', modelCount: 2, lastVerifiedAt: new Date().toISOString() }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ connection, models: [{ name: 'gpt-test' }] }) })
    })

    await page.goto('/settings/config')
    const hub = page.getByTestId('provider-hub')
    await expect(hub).toBeVisible({ timeout: 10000 })
    await page.getByTestId('provider-hub-connect').click()
    await expect(page.getByTestId('provider-picker-modal')).toBeVisible()
    await page.getByTestId('provider-picker-search').fill('OpenAI')
    await page.getByTestId('provider-picker-openai').click()

    const form = page.getByTestId('provider-connection-modal')
    await expect(form).toBeVisible()
    await form.locator('input').nth(0).fill('Test OpenAI')
    await form.locator('input[type="password"]').fill('sk-test-key')
    await form.getByRole('button', { name: '验证并保存' }).click()
    await expect(form).toBeHidden({ timeout: 10000 })
    await expect(hub.getByText('Test OpenAI')).toBeVisible({ timeout: 10000 })
    await expect(hub.getByTestId('provider-connection-openai').getByText('已连接')).toBeVisible()
    await expect(page).toHaveScreenshot('plan-269-provider-connected.png')

    await hub.getByTestId('provider-connection-openai').getByRole('button', { name: '验证', exact: true }).click()
    await expect(hub.getByText('刚刚验证')).toBeVisible({ timeout: 10000 })
    page.once('dialog', (dialog) => dialog.accept())
    await hub.getByRole('button', { name: '删除' }).click()
    await expect(hub.getByText('尚未连接 Provider')).toBeVisible({ timeout: 10000 })
  })

  test('MCP JSON validation and Data import preview are recoverable', async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Session 1' }] })
    await mockSettingsApis(page)

    await page.goto('/settings/config')
    const mcp = page.getByTestId('mcp-config-textarea')
    await mcp.fill('{invalid')
    await page.getByRole('button', { name: '保存' }).last().click()
    await expect(page.getByText('JSON 格式无效')).toBeVisible()

    await page.goto('/settings/data')
    const input = page.locator('input[type="file"]')
    await input.setInputFiles({
      name: 'import.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ chats: [{ messages: [{ content: 'hello' }] }] })),
    })
    await expect(page.getByText('import.json')).toBeVisible()
    await expect(page.getByText('聊天会话')).toBeVisible()
    await expect(page).toHaveScreenshot('plan-269-data-import-preview.png')
  })

  test('Knowledge Base uploads a file and refreshes its document list', async ({ page }) => {
    await setupMockAuth(page)
    await mockSettingsApis(page)
    let uploaded = false
    await page.unroute('**/api/v1/rag/stats')
    await page.route('**/api/v1/rag/stats', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ documents: uploaded ? [{ id: 'doc-1', filename: 'guide.md', chunks: 2 }] : [] }),
    }))
    await page.route('**/api/v1/rag/ingest', async (route) => {
      uploaded = true
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ status: 'ok' }) })
    })

    await page.goto('/settings/knowledge')
    await page.locator('input[type="file"]').setInputFiles({
      name: 'guide.md', mimeType: 'text/markdown', buffer: Buffer.from('# Guide'),
    })
    await page.getByRole('button', { name: '上传' }).click()
    await expect(page.getByText('guide.md')).toBeVisible({ timeout: 10000 })
    await expect(page).toHaveScreenshot('plan-269-knowledge-uploaded.png')
  })
})

test.describe('PLAN-269 full UI acceptance: workspace and mobile', () => {
  test('workspace file read/edit/save uses the visible editor path', async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Session 1' }] })
    await page.addInitScript(() => {
      localStorage.setItem('xihe-mock-filetree', JSON.stringify([
        { name: 'README.md', path: 'README.md', type: 'file', size: 20 },
      ]))
    })
    let writes = 0
    await page.route('**/api/v1/mcp', async (route) => {
      const request = route.request().postDataJSON() as { params?: { name?: string } }
      const tool = request.params?.name
      const result = tool === 'read_file'
        ? { content: [{ type: 'text', text: '# README\n\nOriginal' }] }
        : tool === 'write_file'
          ? (writes++, { content: [{ type: 'text', text: 'saved' }] })
          : { content: [{ type: 'text', text: JSON.stringify({ entries: [] }) }] }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }) })
    })

    await page.goto('/workspace/workspace-1')
    const file = page.getByRole('button', { name: 'README.md', exact: true })
    await expect(file).toBeVisible()
    await file.click()
    await expect(page.getByText('README', { exact: false }).first()).toBeVisible({ timeout: 10000 })
    await page.getByRole('button', { name: '源码' }).click()
    const editor = page.getByTestId('workspace-markdown-source')
    await editor.fill('# README\n\nChanged')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('button', { name: '已保存', exact: true })).toBeVisible()
    expect(writes).toBe(1)
    await expect(page).toHaveScreenshot('plan-269-workspace-editor-saved.png')
  })

  test('mobile workspace exposes Files and Chat Sheets without overflow', async ({ page }) => {
    test.setTimeout(45000)
    await page.setViewportSize({ width: 390, height: 844 })
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Session 1' }] })
    await page.addInitScript(() => localStorage.setItem('xihe-mock-filetree', JSON.stringify([])))
    await page.route('**/api/v1/mcp', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ entries: [] }) }] } }),
    }))

    await page.goto('/workspace/workspace-1')
    await page.reload()
    await page.getByRole('button', { name: 'Files' }).click()
    await expect(page.getByTestId('mobile-files-sheet')).toBeVisible()
    await expect(page).toHaveScreenshot('plan-269-mobile-files-sheet.png')
    await page.getByRole('button', { name: /close/i }).last().click()
    await page.getByRole('button', { name: 'Open chat' }).click()
    await expect(page.getByTestId('mobile-chat-sheet')).toBeVisible()

    const overflow = await page.evaluate(() => {
      const doc = document.scrollingElement
      return doc ? doc.scrollWidth - doc.clientWidth : 0
    })
    expect(overflow).toBeLessThanOrEqual(2)
    await expect(page).toHaveScreenshot('plan-269-mobile-chat-sheet.png')
  })

  test('PDF opens through the application FileEditor path', async ({ page }) => {
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Session 1' }] })
    const pdfBase64 = readFileSync(resolve('e2e/assets/sample.pdf')).toString('base64')
    await page.addInitScript(() => {
      localStorage.setItem('xihe-mock-filetree', JSON.stringify([
        { name: 'sample.pdf', path: 'sample.pdf', type: 'file', size: 1024 },
      ]))
    })
    await page.route('**/api/v1/mcp', async (route) => {
      const body = route.request().postDataJSON() as { params?: { name?: string } }
      const result = body.params?.name === 'read_file'
        ? { content: [{ type: 'text', text: pdfBase64 }] }
        : { content: [{ type: 'text', text: JSON.stringify({ entries: [] }) }] }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
      })
    })

    await page.goto('/workspace/workspace-1')
    await page.getByRole('button', { name: 'sample.pdf', exact: true }).click()
    try {
      await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15000 })
    } catch (cause) {
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)}; pageErrors=${JSON.stringify(pageErrors)}; consoleErrors=${JSON.stringify(consoleErrors)}`)
    }
    await expect(page).toHaveScreenshot('plan-269-workspace-pdf.png')
  })

  test('FileEditor selects code, diff, image and unknown-file branches', async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Session 1' }] })
    await page.addInitScript(() => {
      localStorage.setItem('xihe-mock-filetree', JSON.stringify([
        { name: 'main.ts', path: 'main.ts', type: 'file', size: 20 },
        { name: 'image.png', path: 'image.png', type: 'file', size: 68 },
        { name: 'unknown.bin', path: 'unknown.bin', type: 'file', size: 8 },
      ]))
    })
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    await page.route('**/api/v1/mcp', async (route) => {
      const body = route.request().postDataJSON() as { params?: { name?: string; arguments?: { path?: string } } }
      const path = body.params?.arguments?.path
      const content = path === 'main.ts' ? 'const answer = 42' : path === 'image.png' ? tinyPng : 'opaque binary content'
      const result = body.params?.name === 'read_file'
        ? { content: [{ type: 'text', text: content }] }
        : { content: [{ type: 'text', text: JSON.stringify({ entries: [] }) }] }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, result }),
      })
    })

    await page.goto('/workspace/workspace-1')
    await page.getByRole('button', { name: 'main.ts', exact: true }).click()
    const codeEditor = page.getByTestId('workspace-code-editor')
    await expect(codeEditor).toBeVisible()
    await codeEditor.locator('textarea').fill('const answer = 43')
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: '差异', exact: true }).click()
    await expect(page.getByTestId('workspace-diff-viewer')).toBeVisible()

    await page.getByRole('button', { name: 'image.png', exact: true }).click()
    await expect(page.getByTestId('workspace-image-preview')).toBeVisible()
    await expect(page.getByTestId('workspace-image-preview').getByRole('img', { name: 'image.png' })).toBeVisible()

    await page.getByRole('button', { name: 'unknown.bin', exact: true }).click()
    await expect(page.getByTestId('workspace-unknown-file')).toBeVisible()
    await expect(page).toHaveScreenshot('plan-269-workspace-editor-branches.png')
  })

  test('controlled screen capture creates a visible attachment', async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'session-1', title: 'Session 1' }] })
    await page.addInitScript(() => {
      const track = { stop() {} }
      const stream = { getVideoTracks: () => [track], getTracks: () => [track] }
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async () => stream,
      })
      Object.defineProperty(window, 'ImageCapture', {
        configurable: true,
        value: class {
          constructor() {}
          async grabFrame() {
            const canvas = document.createElement('canvas')
            canvas.width = 2
            canvas.height = 2
            const context = canvas.getContext('2d')
            if (context) {
              context.fillStyle = '#d97706'
              context.fillRect(0, 0, 2, 2)
            }
            return canvas
          }
        },
      })
    })
    await page.goto('/chat/session-1')
    await expect(page.locator('textarea')).toBeVisible()
    await page.getByTitle('截取屏幕').click()
    await expect(page.getByTestId('selected-attachment')).toBeVisible({ timeout: 10000 })
    await expect(page).toHaveScreenshot('plan-269-screen-capture-attachment.png')
  })
})
