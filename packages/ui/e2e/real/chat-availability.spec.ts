import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const mode = process.env.XIHE_E2E_LLM_MODE ?? 'mock'

type Auth = { accessToken: string; workspaceId: string }

async function register(request: APIRequestContext, name: string): Promise<Auth> {
  const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
    data: {
      email: `${name}-${Date.now()}@test.com`,
      password: SHARED_PASSWORD,
      name,
    },
  })
  expect(response.ok()).toBe(true)
  const body = await response.json()
  return { accessToken: body.accessToken, workspaceId: body.workspaceId }
}

async function sessionId(request: APIRequestContext, auth: Auth): Promise<string> {
  let id = ''
  await expect.poll(async () => {
    const response = await request.get(`${CP_URL}/api/v1/sessions`, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'X-Workspace-Id': auth.workspaceId,
      },
    })
    if (!response.ok()) return ''
    const body = await response.json()
    id = body.sessions?.[0]?.id ?? ''
    return id
  }, { timeout: 10000 }).not.toBe('')
  return id
}

async function messages(request: APIRequestContext, auth: Auth, id: string) {
  const response = await request.get(`${CP_URL}/api/v1/sessions/${id}/messages`, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      'X-Workspace-Id': auth.workspaceId,
    },
  })
  return response.ok() ? await response.json() : []
}

async function openChat(page: Page, auth: Auth) {
  await page.addInitScript(({ token, workspaceId }) => {
    localStorage.setItem('xihe-token', token)
    localStorage.setItem('xihe-user', JSON.stringify({ workspaceId }))
    localStorage.setItem('xihe-workspace', JSON.stringify({ id: workspaceId, name: 'Default Workspace' }))
  }, { token: auth.accessToken, workspaceId: auth.workspaceId })
  await page.goto('/chat', { waitUntil: 'load' })
  await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(1)
}

test.describe('PLAN-247 Chat availability @host', () => {
  if (mode === 'missing') {
    test('missing credentials preserve input and create no messages', async ({ page, request }) => {
    const auth = await register(request, 'missing-credentials')
    await openChat(page, auth)

    const text = `missing-${Date.now()}`
    const textarea = page.locator('textarea')
    await textarea.fill(text)
    await page.keyboard.press('Enter')

    await expect(page.getByText(/LLM_NOT_CONFIGURED/)).toBeVisible({ timeout: 10000 })
    await expect(textarea).toHaveValue(text)
    const id = await sessionId(request, auth)
    await expect.poll(async () => (await messages(request, auth, id)).length, { timeout: 5000 }).toBe(0)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: test.info().outputPath('PLAN-247-host-no-credentials.png'), fullPage: true })
    })
  }

  if (mode === 'invalid') {
    test('provider credential failure is visible without a ghost assistant', async ({ page, request }) => {
    const auth = await register(request, 'invalid-credentials')
    await openChat(page, auth)

    const text = `invalid-${Date.now()}`
    const textarea = page.locator('textarea')
    await textarea.fill(text)
    await page.keyboard.press('Enter')

    await expect(page.getByText(/LLM_CREDENTIALS_INVALID/)).toBeVisible({ timeout: 10000 })
    await expect(textarea).toHaveValue(text)
    const id = await sessionId(request, auth)
    const stored = await messages(request, auth, id)
    expect(stored.some((message: { role?: string }) => message.role === 'ASSISTANT')).toBe(false)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: test.info().outputPath('PLAN-247-host-credential-error.png'), fullPage: true })
    })
  }

  if (mode === 'success') {
    test('fake provider streams multiple tokens and persists the canonical binding', async ({ page, request }) => {
    const auth = await register(request, 'fake-success')
    const mcpRequests: string[] = []
    page.on('request', (outgoing) => {
      if (/\/api\/v1\/mcp|tools\/list/.test(outgoing.url())) mcpRequests.push(outgoing.url())
    })
    await openChat(page, auth)

    const trigger = page.getByTestId('model-popover-trigger')
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.getByText('fake-openai', { exact: true })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('fake-openai-asr', { exact: true })).not.toBeVisible()
    const modelSearch = page.getByTestId('model-popover-search')
    await modelSearch.fill('fake-deepseek')
    await expect(page.getByTestId('model-item-deepseek/fake-deepseek')).toBeVisible()
    await modelSearch.press('ArrowDown')
    await modelSearch.press('Enter')

    const id = await sessionId(request, auth)
    await expect.poll(async () => {
      const response = await request.get(`${CP_URL}/api/v1/sessions/${id}`, {
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'X-Workspace-Id': auth.workspaceId,
        },
      })
      if (!response.ok()) return ''
      const body = await response.json()
      return `${body.modelProvider ?? ''}/${body.modelName ?? ''}`
    }, { timeout: 10000 }).toBe('deepseek/fake-deepseek')

    const text = `success-${Date.now()}`
    await page.locator('textarea').fill(text)
    await page.keyboard.press('Enter')
    await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 10000 })
    await expect.poll(async () => {
      const stored = await messages(request, auth, id)
      return stored.filter((message: { role?: string; content?: string }) =>
        message.role === 'ASSISTANT' && message.content?.includes('deepseek fake')).length
    }, { timeout: 30000 }).toBeGreaterThan(0)
    await expect(page.getByText(/Thinking/)).not.toBeVisible({ timeout: 30000 })
    expect(mcpRequests).toEqual([])
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: test.info().outputPath('PLAN-247-host-fake-success.png'), fullPage: true })

    await page.reload({ waitUntil: 'load' })
    await expect(page.locator('textarea')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText(/deepseek fake/)).toBeVisible({ timeout: 15000 })
    await expectNoHorizontalOverflow(page)
    })
  }

  if (mode === 'real') {
    test('real Xiaomi streams a reply and persists the canonical binding', async ({ page, request }) => {
    test.setTimeout(180000)
    const auth = await register(request, 'real-xiaomi')
    await openChat(page, auth)

    const trigger = page.getByTestId('model-popover-trigger')
    await expect(trigger).toBeVisible()
    await trigger.click()
    await expect(page.getByText('mimo-v2.5', { exact: true }).first()).toBeVisible({ timeout: 15000 })
    const modelSearch = page.getByTestId('model-popover-search')
    await modelSearch.fill('mimo-v2.5')
    // The exact item is the first filter match (plain Enter selects it).
    // ArrowDown would move highlight to mimo-v2.5-pro; .click() never
    // stabilizes because the open popover list re-renders continuously.
    await expect(page.getByTestId('model-item-xiaomi/mimo-v2.5')).toBeVisible()
    await modelSearch.press('Enter')

    const id = await sessionId(request, auth)
    await expect.poll(async () => {
      const response = await request.get(`${CP_URL}/api/v1/sessions/${id}`, {
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          'X-Workspace-Id': auth.workspaceId,
        },
      })
      if (!response.ok()) return ''
      const body = await response.json()
      return `${body.modelProvider ?? ''}/${body.modelName ?? ''}`
    }, { timeout: 15000 }).toBe('xiaomi/mimo-v2.5')

    const text = `real-${Date.now()}`
    await page.locator('textarea').fill(text)
    await page.keyboard.press('Enter')
    await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 15000 })
    await expect.poll(async () => {
      const stored = await messages(request, auth, id)
      return stored.filter((message: { role?: string; content?: string }) =>
        message.role === 'ASSISTANT' && (message.content?.length ?? 0) > 0).length
    }, { timeout: 120000 }).toBeGreaterThan(0)
    await expect(page.getByText(/Thinking/)).not.toBeVisible({ timeout: 60000 })
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: test.info().outputPath('PLAN-247-host-real-xiaomi.png'), fullPage: true })
    })
  }

  if (mode === 'disconnect') {
    test('provider disconnect is durable ambiguous and not auto-retried', async ({ page, request }) => {
    const auth = await register(request, 'ambiguous-disconnect')
    await openChat(page, auth)

    const id = await sessionId(request, auth)
    const text = `disconnect-${Date.now()}`
    await page.locator('textarea').fill(text)
    await page.keyboard.press('Enter')
    await expect.poll(async () => {
      const stored = await messages(request, auth, id)
      return stored.some((message: { runStatus?: string }) => message.runStatus === 'ambiguous')
    }, { timeout: 30000 }).toBe(true)
    await expectNoHorizontalOverflow(page)
    await page.screenshot({ path: test.info().outputPath('PLAN-247-host-run-ambiguous.png'), fullPage: true })
    })
  }
})
