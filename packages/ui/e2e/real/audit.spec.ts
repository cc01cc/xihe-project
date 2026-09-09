import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { generateE2EPassword } from './helpers/password'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

type Auth = {
  accessToken: string
  workspaceId: string
}

type OperationSummary = {
  id: string
  sessionId?: string
  status: string
  summary?: string
}

async function register(request: APIRequestContext): Promise<Auth> {
  const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
  const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
    data: {
      email: `audit-real-${Date.now()}@test.local`,
      password,
      name: 'Audit Real',
    },
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

async function findSessionId(request: APIRequestContext, auth: Auth): Promise<string> {
  const response = await request.get(`${CP_URL}/api/v1/sessions`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  })
  expect(response.ok(), await response.text()).toBe(true)
  const body = await response.json() as { sessions?: Array<{ id: string }> }
  return body.sessions?.[0]?.id ?? ''
}

async function findOperation(request: APIRequestContext, auth: Auth, sessionId: string): Promise<OperationSummary | null> {
  const response = await request.get(`${CP_URL}/api/v1/operations?sessionId=${encodeURIComponent(sessionId)}&size=100`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  })
  if (!response.ok()) return null
  const body = await response.json() as { operations?: OperationSummary[] }
  return body.operations?.[0] ?? null
}

async function agentLlmReadiness(request: APIRequestContext, auth: Auth): Promise<string> {
  const response = await request.get(`${CP_URL}/api/v1/status`, {
    headers: { Authorization: `Bearer ${auth.accessToken}` },
  })
  if (!response.ok()) return 'unknown'
  const body = await response.json() as {
    services?: Array<{ key?: string; llmReady?: string }>
  }
  return body.services?.find((service) => service.key === 'agent')?.llmReady ?? 'unknown'
}

test.describe.configure({ retries: 0 })

test('@host PLAN-281 User Audit persists Chat operation trace', async ({ page, request }, testInfo) => {
  test.setTimeout(180000)
  const auth = await register(request)
  await installAuth(page, auth)

  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto('/chat', { waitUntil: 'load' })
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 20000 })
  await expect.poll(() => agentLlmReadiness(request, auth), { timeout: 60000 }).toBe('ready')

  const chatResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'POST'
      && url.pathname === '/api/v1/chat'
      && response.status() === 202
  })
  await page.getByRole('button', { name: '今天天气怎么样？', exact: true }).click()
  await chatResponse

  await expect.poll(() => findSessionId(request, auth), { timeout: 20000 }).not.toBe('')
  const sessionId = await findSessionId(request, auth)
  await expect.poll(() => findOperation(request, auth, sessionId), { timeout: 20000 }).not.toBeNull()
  const operation = await findOperation(request, auth, sessionId)
  const operationId = (operation as OperationSummary).id

  await page.goto('/settings/audit', { waitUntil: 'load' })
  const listResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET'
      && url.pathname === '/api/v1/operations'
      && response.status() === 200
  })
  await page.reload({ waitUntil: 'load' })
  await listResponse

  const operationButton = page.getByTestId(`settings-audit-operation-${operationId}`)
  await expect(operationButton).toBeVisible({ timeout: 20000 })

  const traceResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET'
      && url.pathname === `/api/v1/operations/${operationId}`
      && response.status() === 200
  })
  await operationButton.click()
  const trace = await traceResponse.then((response) => response.json() as Promise<{
    operation: OperationSummary
    items: Array<{ toolName?: string; status: string }>
    events: Array<{ eventType: string; state: string }>
  }>)

  await expect(page.getByText('chat', { exact: true }).last()).toBeVisible({ timeout: 10000 })
  await expect(page.getByText(/Chat operation|audit this chat operation/).first()).toBeVisible()
  expect(trace.operation.id).toBe(operationId)
  expect(trace.operation.sessionId).toBe(sessionId)
  expect(trace.events.length).toBeGreaterThan(0)
  await expect(page.getByTestId('settings-audit-events')).toContainText('operation.')
  expect(pageErrors).toEqual([])

  await page.screenshot({ path: testInfo.outputPath('plan-281-real-audit-after-trace.png'), fullPage: true })
})
