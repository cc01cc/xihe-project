import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

// Single serial test on purpose: the Agent keeps a process-level MCP workspace
// binding (PLAN-262 boundary), so the approve → reject → persistence flow must
// share one registered user/workspace and one browser session. Retries create
// a fresh workspace via the in-test register and cannot reuse the same Agent.
test.skip(
  process.env.XIHE_E2E_LLM_MODE !== 'approval',
  'approval flow requires XIHE_E2E_LLM_MODE=approval',
)

test('@host Chat approval — approve, reject and persistence in one flow', async ({ page, request }) => {
  test.setTimeout(180000)

  const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
  const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
    data: { email: `approval-real-${Date.now()}@test.com`, password, name: 'ApprovalReal' },
  })
  expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(reg.status())
  const auth = await reg.json()
  const authToken: string = auth.accessToken
  const wsId: string = auth.workspaceId
  const authHeaders = { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }

  await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
  await page.addInitScript((raw) => localStorage.setItem('xihe-user', raw), JSON.stringify({ workspaceId: wsId }))
  await page.addInitScript(
    (ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)),
    { id: wsId, name: 'Default Workspace' },
  )

  await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 20000 })
  const modal = page.locator('[data-testid="modal-content"]')

  // Phase 1 — approve: modal shows action/details, decision lands, agent answers.
  await textarea.fill('please delete README.md')
  await textarea.press('Enter')
  await expect(modal).toBeVisible({ timeout: 60000 })
  await expect(modal.locator('text=delete file')).toBeVisible()
  await expect(modal.locator('text=README.md')).toBeVisible()
  await expect(page).toHaveScreenshot('approval-real-modal.png')
  await modal.locator('[data-testid="approval-approve"]').click()
  await expect(modal).toBeHidden({ timeout: 20000 })
  await expect(page.locator('text=Approval received.').first()).toBeVisible({ timeout: 60000 })

  // Phase 2 — reject: terminal APPROVAL_REJECTED error is visible.
  await expect(textarea).toBeVisible({ timeout: 20000 })
  await textarea.fill('please delete README.md again')
  await textarea.press('Enter')
  await expect(modal).toBeVisible({ timeout: 60000 })
  await modal.locator('[data-testid="approval-reject"]').click()
  await expect(modal).toBeHidden({ timeout: 20000 })
  await expect(page.locator('text=APPROVAL_REJECTED').first()).toBeVisible({ timeout: 60000 })

  // Phase 3 — persistence: reload restores history, no stale approval modal,
  // and the session transcript keeps user + assistant messages.
  await page.reload({ waitUntil: 'load' })
  await expect(page.locator('textarea')).toBeVisible({ timeout: 20000 })
  await page.waitForTimeout(3000)
  await expect(page.locator('[data-testid="modal-content"]')).toBeHidden()

  const sessionsRes = await request.get(`${CP_URL}/api/v1/sessions`, { headers: authHeaders })
  expect(sessionsRes.ok()).toBeTruthy()
  const sessions = (await sessionsRes.json()) as { sessions: Array<{ id: string }> }
  expect(sessions.sessions.length).toBeGreaterThan(0)
  const sid = sessions.sessions[0].id
  const messagesRes = await request.get(`${CP_URL}/api/v1/sessions/${sid}/messages`, { headers: authHeaders })
  expect(messagesRes.ok()).toBeTruthy()
  const messages = (await messagesRes.json()) as Array<{ role: string; content: string }>
  const roles = messages.map((m) => m.role.toUpperCase())
  expect(roles).toContain('USER')
  expect(roles).toContain('ASSISTANT')
  const approvalsRes = await request.get(`${CP_URL}/api/v1/events?sessionId=${sid}`, {
    headers: { Authorization: `Bearer ${authToken}` },
  })
  expect(approvalsRes.status(), 'sse replay endpoint reachable').toBe(200)
})
