import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { generateE2EPassword } from './helpers/password'
import { ensureAgentWorkspaceBinding, getRootBranchId, waitForControlPlaneAgentReady } from './helpers/journey'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? 'mock'

test.describe.configure({ mode: 'serial', retries: 0 })

function seedUserGrant(userId: string, workspaceId: string) {
  const container = process.env.XIHE_E2E_PG_CONTAINER
  const database = process.env.XIHE_E2E_PG_DATABASE
  const dbUser = process.env.XIHE_E2E_PG_USER
  if (!container || !database || !dbUser) {
    throw new Error('isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs')
  }
  const permissions = JSON.stringify([
    { actionClass: 'CREATE_ACCOUNT', resource: '*' },
    { actionClass: 'CREATE_TEMPLATE', resource: '*' },
    { actionClass: 'MANAGE_WORKSPACE_AGENTS', resource: workspaceId },
    { actionClass: 'delete', resource: '*' },
    { actionClass: 'write', resource: '*' },
  ]).replaceAll("'", "''")
  execFileSync(process.platform === 'win32' ? 'docker.exe' : 'docker', [
    'exec', container, 'psql', '-X', '-A', '-t', '-U', dbUser, '-d', database, '-c',
    `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state) `
      + `VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid, `
      + `'${permissions}'::jsonb, 'direct', 'read')`,
  ], { encoding: 'utf8', timeout: 15_000, windowsHide: true })
}

async function createBoundAgent(
  request: APIRequestContext,
  options: {
    userId: string
    workspaceId: string
    headers: Record<string, string>
    name: string
    actionClass: 'delete' | 'write'
  },
): Promise<string> {
  const { userId, workspaceId, headers, name, actionClass } = options
  seedUserGrant(userId, workspaceId)
  const roleId = randomUUID()
  const templateId = randomUUID()
  const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
    headers,
    data: {
      roles: JSON.stringify([{
        id: roleId,
        name: `${name} Role`,
        permissions: [{ actionClass, resource: '*' }],
      }]),
      templates: JSON.stringify([{
        id: templateId,
        name,
        description: 'Bounded Agent fixture for Host approval verification',
        systemPrompt: 'Use only the Workspace tools provided by CP.',
        toolMode: 'workspace',
        provider: 'openai',
        model: 'fake-openai',
        roleId,
      }]),
    },
  })
  expect(templateWrite.status(), await templateWrite.text()).toBe(200)

  const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
    headers,
    data: { name, templateId },
  })
  expect(principalResponse.status(), await principalResponse.text()).toBe(201)
  const principalId = (await principalResponse.json() as { principalId: string }).principalId
  const bindResponse = await request.put(`${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`, {
    headers,
    data: { permissions: [{ actionClass, resource: '*' }] },
  })
  expect(bindResponse.status(), await bindResponse.text()).toBe(200)
  const agentsResponse = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceId}/agents`, { headers })
  expect(agentsResponse.status(), await agentsResponse.text()).toBe(200)
  expect((await agentsResponse.json() as Array<{ principalId: string }>).map((agent) => agent.principalId))
    .toContain(principalId)
  return principalId
}

async function submitChat(page: Page, prompt: string): Promise<string> {
  const posted = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/chat') && response.request().method() === 'POST',
  )
  await page.locator('textarea').fill(prompt)
  await page.getByTestId('chat-send-button').click()
  const response = await posted
  expect(response.status(), await response.text()).toBe(202)
  const body = await response.json() as { runId?: string }
  expect(body.runId).toBeTruthy()
  return body.runId!
}

// Single serial test on purpose: the Agent keeps a process-level MCP workspace
// binding (PLAN-262 boundary), so the approve → reject → persistence flow must
// share one registered user/workspace and one browser session. Retries create
// a fresh workspace via the in-test register and cannot reuse the same Agent.
test('@host Chat approval — approve, reject and persistence in one flow', async ({ page, request }) => {
  test.skip(LLM_MODE !== 'approval', 'approval dialog flow requires XIHE_E2E_LLM_MODE=approval')
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

  const meResponse = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: authHeaders })
  expect(meResponse.ok(), await meResponse.text()).toBe(true)
  const userId = (await meResponse.json() as { id: string }).id
  await createBoundAgent(request, {
    userId,
    workspaceId: wsId,
    headers: authHeaders,
    name: 'Approval Agent',
    actionClass: 'delete',
  })

  // PLAN-0369: single-binding Agent — rebind before the workspace-tool chat.
  await ensureAgentWorkspaceBinding(wsId)
  await waitForControlPlaneAgentReady(request, authHeaders)

  await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
  await page.addInitScript((raw) => localStorage.setItem('xihe-user', raw), JSON.stringify({ workspaceId: wsId }))
  await page.addInitScript(
    (ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)),
    { id: wsId, name: 'Default Workspace' },
  )

  await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
  await page.getByTestId('workspace-create-session').click()
  const agentSelect = page.getByTestId('workspace-agent-principal-select')
  await expect(agentSelect).toBeVisible()
  await agentSelect.selectOption({ index: 1 })
  await page.getByTestId('workspace-create-agent-session').click()
  const textarea = page.locator('textarea')
  await expect(textarea).toBeVisible({ timeout: 20000 })
  const modal = page.locator('[data-testid="modal-content"]')

  // Phase 1 — approve: modal shows action/details, decision lands, agent answers.
  const approvedRunId = await submitChat(page, 'please delete README.md')
  await expect(modal).toBeVisible({ timeout: 60000 })
  await expect(modal.locator('text=delete file')).toBeVisible()
  await expect(modal.locator('text=README.md')).toBeVisible()
  await expect(page).toHaveScreenshot('approval-real-modal.png', {
    mask: [page.locator('time'), page.getByTestId('workspace-active-agent')],
  })
  await modal.locator('[data-testid="approval-approve"]').click()
  await expect(modal).toBeHidden({ timeout: 20000 })
  await expect(page.locator('text=Approval received.').first()).toBeVisible({ timeout: 60000 })

  // Phase 2 — reject: terminal APPROVAL_REJECTED error is visible.
  await expect(textarea).toBeVisible({ timeout: 20000 })
  const rejectedRunId = await submitChat(page, 'please delete README.md again')
  expect(rejectedRunId).not.toBe(approvedRunId)
  await expect(modal).toBeVisible({ timeout: 60000 })
  await modal.locator('[data-testid="approval-reject"]').click()
  await expect(modal).toBeHidden({ timeout: 20000 })
  await expect(page.locator('text=APPROVAL_REJECTED').first()).toBeVisible({ timeout: 60000 })

  // Phase 3 — persistence: reload restores history, no stale approval modal,
  // and the session transcript keeps user + assistant messages.
  await page.reload({ waitUntil: 'load' })
  await expect(page.locator('textarea')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('[data-testid="modal-content"]')).toBeHidden()

  const sessionsRes = await request.get(`${CP_URL}/api/v1/sessions`, { headers: authHeaders })
  expect(sessionsRes.ok()).toBeTruthy()
  const sessions = (await sessionsRes.json()) as { sessions: Array<{ id: string }> }
  expect(sessions.sessions.length).toBeGreaterThan(0)
  const sid = sessions.sessions[0].id
  const branchId = await getRootBranchId(request, sid, authHeaders)
  const messagesRes = await request.get(`${CP_URL}/api/v1/sessions/${sid}/messages?branchId=${branchId}`, { headers: authHeaders })
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
