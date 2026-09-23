import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { generateE2EPassword } from './helpers/password'

/**
 * PLAN-0337 M1 真实链路验收（@host）：
 * - Workspace 级 `approval-policy.mode` 有真实 UI 写入面，刷新后仍生效（读回 DB）；
   * - Session 级模式落库（V24），Workspace Chat 路由的模式控件与 DB 一致；
 * - 断言 request/response 与页面可见结果一致，不依赖 mock。
 *
 * 依赖：`mise run dev:host`（或 `scripts/e2e-host.mjs` 提供的隔离栈）。CP 重启后的保留性由
 * evidence 中的进程级复跑单独记录，spec 内部只断言 DB 往返与页面一致。
 */
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

type Auth = {
  accessToken: string
  workspaceId: string
}

async function register(request: APIRequestContext): Promise<Auth> {
  const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
  const response = await request.post(`${CP_URL}/api/v1/auth/register`, {
    data: {
      email: `approval-policy-real-${Date.now()}@test.local`,
      password,
      name: 'Approval Policy Real',
    },
  })
  expect(response.status(), await response.text()).toBe(201)
  const body = await response.json() as { accessToken: string; workspaceId: string }
  return { accessToken: body.accessToken, workspaceId: body.workspaceId }
}

function authHeaders(auth: Auth) {
  return { Authorization: `Bearer ${auth.accessToken}` }
}

async function installAuth(page: Page, auth: Auth) {
  await page.addInitScript(({ token, workspaceId }) => {
    localStorage.setItem('xihe-token', token)
    localStorage.setItem('xihe-user', JSON.stringify({ workspaceId }))
    localStorage.setItem('xihe-workspace', JSON.stringify({ id: workspaceId, name: 'Default Workspace' }))
  }, { token: auth.accessToken, workspaceId: auth.workspaceId })
}

async function createSession(request: APIRequestContext, auth: Auth, title: string): Promise<string> {
  const response = await request.post(`${CP_URL}/api/v1/sessions`, {
    headers: authHeaders(auth),
    data: { title },
  })
  expect(response.status(), await response.text()).toBe(201)
  const body = await response.json() as { id?: string; sessionId?: string }
  const id = body.id ?? body.sessionId
  expect(id, 'session id must be returned').toBeTruthy()
  return id as string
}

async function setSessionMode(request: APIRequestContext, auth: Auth,
                              { sessionId, mode }: { sessionId: string; mode: string }) {
  const response = await request.post(`${CP_URL}/api/v1/policy/mode`, {
    headers: authHeaders(auth),
    data: { sessionId, mode },
  })
  expect(response.status(), await response.text()).toBe(200)
  return response.json() as Promise<{ mode?: string; scope?: string }>
}

async function readSessionMode(request: APIRequestContext, auth: Auth, sessionId: string): Promise<string> {
  const response = await request.get(
    `${CP_URL}/api/v1/policy/mode?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: authHeaders(auth) },
  )
  expect(response.ok(), await response.text()).toBe(true)
  const body = await response.json() as { mode?: string }
  return body.mode ?? ''
}

async function resolvedApprovalMode(request: APIRequestContext, auth: Auth): Promise<string> {
  const response = await request.get(
    `${CP_URL}/api/v1/config/approval-policy?workspaceId=${encodeURIComponent(auth.workspaceId)}`,
    { headers: authHeaders(auth) },
  )
  expect(response.ok(), await response.text()).toBe(true)
  const body = await response.json() as Record<string, unknown>
  const value = body.mode
  return typeof value === 'string' ? value : ''
}

test.describe.configure({ retries: 0 })

test('@host PLAN-0337 Workspace approval mode is set in Settings and survives a reload', async ({ page, request }, testInfo) => {
  const auth = await register(request)
  await installAuth(page, auth)

  await page.goto('/settings/config', { waitUntil: 'load' })

  // Instance 层不得出现该域：审批模式只有 workspace 一个配置面（PLAN-0337）。
  await expect(page.getByTestId('config-domain-approval-policy')).toHaveCount(0)

  await page.getByTestId('config-tab-workspace').click()
  const domain = page.getByTestId('config-domain-approval-policy')
  await expect(domain).toBeVisible()
  await domain.locator('button').first().click()

  const modeSelect = page.getByTestId('config-field-approval-policy-mode').locator('select')
  await expect(modeSelect).toBeVisible()

  const [saveRequest] = await Promise.all([
    page.waitForRequest((req) =>
      req.method() === 'PUT' && req.url().includes('/api/v1/config/workspace/approval-policy')),
    (async () => {
      await modeSelect.selectOption('auto')
      await domain.getByRole('button', { name: '保存' }).click()
    })(),
  ])
  expect(JSON.parse(saveRequest.postData() ?? '{}').mode).toBe('auto')

  // DB 往返：解析读回 auto。
  await expect.poll(() => resolvedApprovalMode(request, auth), { timeout: 10000 }).toBe('auto')

  // 刷新后仍生效（页面从 DB 读回，而不是前端缓存）。
  await page.reload({ waitUntil: 'load' })
  await page.getByTestId('config-tab-workspace').click()
  await page.getByTestId('config-domain-approval-policy').locator('button').first().click()
  await expect(page.getByTestId('config-field-approval-policy-mode').locator('select')).toHaveValue('auto')

  await page.screenshot({ path: testInfo.outputPath('approval-policy-workspace.png') })
})

test('@host PLAN-0337 Session approval mode is persisted and reflected by the chat control', async ({ page, request }, testInfo) => {
  const auth = await register(request)
  const sessionId = await createSession(request, auth, 'Approval Policy Real')
  await installAuth(page, auth)

  const created = await setSessionMode(request, auth, { sessionId, mode: 'auto' })
  expect(created.mode).toBe('auto')
  expect(created.scope).toBe('session')

  // 落库读回：模式来自 sessions.approval_mode（V24），非进程内存。
  await expect.poll(() => readSessionMode(request, auth, sessionId), { timeout: 10000 }).toBe('auto')

  await page.goto(`/workspace/${auth.workspaceId}/chat/${sessionId}`, { waitUntil: 'load' })
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 15000 })
  // 模式控件是 <select>：断言选中值（文本是各选项标签拼接，不能整段比对）。
  await expect(page.getByTestId('session-policy-mode')).toHaveValue('auto')
  await expect(page.getByTestId('session-policy-auto-banner')).toBeVisible()

  await page.screenshot({ path: testInfo.outputPath('approval-policy-session-auto.png') })

  await setSessionMode(request, auth, { sessionId, mode: 'manual' })
  await expect.poll(() => readSessionMode(request, auth, sessionId), { timeout: 10000 }).toBe('manual')

  await page.reload({ waitUntil: 'load' })
  await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 15000 })
  await expect(page.getByTestId('session-policy-mode')).toHaveValue('manual')
  await expect(page.getByTestId('session-policy-auto-banner')).toHaveCount(0)

  await page.screenshot({ path: testInfo.outputPath('approval-policy-session-manual.png') })

  // 不可达依赖必须失败：模式接口读回空串视为异常。
  expect(await readSessionMode(request, auth, sessionId)).not.toBe('')
})
