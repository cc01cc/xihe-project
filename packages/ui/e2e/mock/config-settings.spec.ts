import { test, expect } from '@playwright/test'

const CONFIG_DOMAINS: Record<string, Record<string, string>> = {
  'llm-provider': { defaultProvider: 'deepseek', defaultModel: 'deepseek-chat' },
  'context-policy': { defaults: '{"softThresholdPct":0.8}' },
  'embedding': { model: 'text-embedding-3-small', dimensions: '1536' },
  'rag': { chunkSize: '1000', topK: '5' },
  'agent-runtime': { useRegistry: 'true' },
  'agent-profile': { userName: 'zero' },
  'user-preference': { theme: 'dark' },
  'logging': { logLevel: 'INFO', levelCp: 'DEBUG' },
}

test.describe('Config Settings (three layers)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token')
      localStorage.setItem('xihe-user', JSON.stringify({ id: 'u1', email: 'admin@xihe.local', role: 'ADMIN' }))
      localStorage.setItem('xihe-workspace', JSON.stringify({ id: 'ws-1', name: 'Mock Workspace' }))
    })
  })

  async function mockConfigAPIs(page: any, options: { delayMs?: number } = {}) {
    // Catch-all first: Playwright routes are LIFO, specific routes below win.
    await page.route('**/api/v1/**', async (route: any) => {
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
    })
    await page.route('**/api/v1/config/**', async (route: any) => {
      const url = new URL(route.request().url())
      const domain = url.pathname.split('/').pop() ?? ''
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', keys: 1 }) })
        return
      }
      const entries = CONFIG_DOMAINS[domain] ?? {}
      // Layer views get the includeMeta envelope; resolved reads stay flat.
      const body = url.searchParams.has('layer')
        ? {
            domain,
            entries,
            envOverridden: domain === 'embedding' ? { model: 'env-embedding-model' } : {},
          }
        : entries
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await page.route('**/api/v1/events**', (route: any) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
  }

  test('renders layer tabs and the import/export entry for admins', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })

    await expect(page.getByTestId('config-tab-instance')).toBeVisible()
    await expect(page.getByTestId('config-tab-workspace')).toBeVisible()
    await expect(page.getByTestId('config-tab-user')).toBeVisible()
    await expect(page.getByTestId('config-import-export')).toBeVisible()
    await expect(page.getByTestId('config-domain-logging')).toBeVisible()
    await expect(page.getByTestId('config-domain-agent-runtime')).toBeVisible()
    await expect(page).toHaveScreenshot('config-instance-tab.png')
  })

  test('instance tab keeps the instance-only instructions field', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })

    await page.getByTestId('config-domain-agent-runtime').locator('button').first().click()
    await expect(page.getByTestId('config-field-agent-runtime-instructions')).toBeVisible()
  })

  test('workspace tab shows five domains and the MCP section', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })

    await page.getByTestId('config-tab-workspace').click()
    await expect(page.getByTestId('config-domain-agent-runtime')).toBeVisible()
    await expect(page.getByTestId('config-domain-agent-profile')).toHaveCount(0)
    await expect(page.getByTestId('config-domain-user-preference')).toHaveCount(0)
    await expect(page.getByTestId('config-domain-logging')).toHaveCount(0)
    await expect(page.getByTestId('mcp-config-textarea')).toBeVisible()
    await expect(page).toHaveScreenshot('config-workspace-tab.png')
  })

  test('user tab drops instance-only domains and the instructions field', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })

    await page.getByTestId('config-tab-user').click()
    await expect(page.getByTestId('config-domain-agent-profile')).toBeVisible()
    await expect(page.getByTestId('config-domain-user-preference')).toBeVisible()
    await expect(page.getByTestId('config-domain-logging')).toHaveCount(0)
    await page.getByTestId('config-domain-agent-runtime').locator('button').first().click()
    await expect(page.getByTestId('config-field-agent-runtime-instructions')).toHaveCount(0)
  })

  test('env-locked field shows the env-effective value and drops the input', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })

    await page.getByTestId('config-tab-workspace').click()
    await page.getByTestId('config-domain-embedding').locator('button').first().click()
    const lock = page.getByTestId('config-env-lock-embedding-model')
    await expect(lock).toBeVisible()
    await expect(lock).toHaveText('env-embedding-model')
    await expect(page.getByTestId('config-field-embedding-model').locator('input')).toHaveCount(0)
    await expect(page).toHaveScreenshot('config-env-lock.png')
  })

  test('saving a value goes through the layer endpoint', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })

    await expect(page.getByTestId('config-domain-logging')).toBeVisible()
    await page.getByTestId('config-domain-logging').locator('button').first().click()
    await page.getByTestId('config-field-logging-levelCp').locator('select').selectOption('ERROR')

    const [request] = await Promise.all([
      page.waitForRequest(req => req.method() === 'PUT' && req.url().includes('/api/v1/config/instance/logging')),
      page.getByTestId('config-domain-logging').getByRole('button', { name: '保存' }).click(),
    ])
    expect(JSON.parse(request.postData() ?? '{}').levelCp).toBe('ERROR')
  })

  test('export triggers the instance export request', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.goto('/settings/config', { waitUntil: 'load' })

    const [request] = await Promise.all([
      page.waitForRequest(req => req.url().includes('/api/v1/config/export')),
      page.getByTestId('config-export-button').click(),
    ])
    expect(request.url()).toContain('layer=instance')
    expect(request.url()).toContain('includeSecrets=true')
  })

  test('import posts the file and renders skip warnings', async ({ page }) => {
    await mockConfigAPIs(page)
    await page.route('**/api/v1/config/import**', async (route: any) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          imported: 2,
          skipped: 1,
          warnings: ['provider-connections: 1 credential(s) skipped - rebuild them via the provider connections API/UI'],
        }),
      })
    })
    await page.goto('/settings/config', { waitUntil: 'load' })

    await page.getByTestId('config-import-input').setInputFiles({
      name: 'config.import.local.jsonc',
      mimeType: 'application/json',
      buffer: Buffer.from('{"logging":{"logLevel":"INFO"}}'),
    })
    await expect(page.getByTestId('config-import-warnings')).toBeVisible()
    await expect(page.getByTestId('config-import-warnings')).toContainText('credential(s) skipped')
  })

  test('shows loading state while layer config is pending', async ({ page }) => {
    await mockConfigAPIs(page, { delayMs: 3000 })
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.locator('text=加载中...')).toBeVisible()
  })

  test('shows an error banner when layer config cannot be loaded', async ({ page }) => {
    await page.route('**/api/v1/**', (route: any) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }))
    await page.route('**/api/v1/config/**', (route: any) => route.abort('connectionrefused'))
    await page.route('**/api/v1/events**', (route: any) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
    await page.goto('/settings/config', { waitUntil: 'load' })
    await expect(page.getByTestId('settings-config-heading')).toBeVisible()
    await expect(page.locator('text=保存失败')).toBeVisible()
  })
})
