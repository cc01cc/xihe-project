import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import {
  CP_URL,
  ensureAgentWorkspaceBinding,
  registerJourneyUser,
  sendChat,
  seedPage,
} from './helpers/journey'
import { workspaceChatPath } from '../../src/lib/routes'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const fakeLlmUrl = new URL(CP_URL)
fakeLlmUrl.port = process.env.XIHE_FAKE_LLM_PORT ?? '13642'
const FAKE_LLM_URL = fakeLlmUrl.origin

test.describe.configure({ mode: 'serial', retries: 0 })
test.skip(
  process.env.XIHE_E2E_LLM_MODE !== 'spawn_agent' || Boolean(process.env.XIHE_E2E_REAL_XIAOMI_KEY),
  'requires the isolated spawn_agent fake LLM mode',
)

function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error('Expected a UUID from the isolated host stack')
  return value
}

function queryIsolatedPostgres(sql: string): string {
  const container = process.env.XIHE_E2E_PG_CONTAINER
  const database = process.env.XIHE_E2E_PG_DATABASE
  const user = process.env.XIHE_E2E_PG_USER
  if (!container || !database || !user) {
    throw new Error('isolated Postgres fixture metadata is unavailable; run through scripts/e2e-host.mjs')
  }
  return execFileSync(process.platform === 'win32' ? 'docker.exe' : 'docker', [
    'exec', container, 'psql', '-X', '-A', '-t', '-U', user, '-d', database, '-c', sql,
  ], { encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim()
}

function scalarCount(sql: string): number {
  const value = queryIsolatedPostgres(sql)
  if (!/^\d+$/.test(value)) throw new Error(`Expected an isolated Postgres count, received: ${value}`)
  return Number(value)
}

function seedUserSpawnPermissions(userId: string, workspaceId: string): void {
  const permissions = JSON.stringify([
    { actionClass: 'CREATE_ACCOUNT', resource: '*' },
    { actionClass: 'MANAGE_WORKSPACE_AGENTS', resource: workspaceId },
    { actionClass: 'SPAWN_AGENT', resource: '*' },
  ]).replaceAll("'", "''")
  queryIsolatedPostgres(`
    INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state)
    VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid,
            '${permissions}'::jsonb, 'direct', 'read')
  `)
}

function addPrincipalSpawnGrant(principalId: string): void {
  const grantId = requireUuid(queryIsolatedPostgres(`
    SELECT id FROM grants
    WHERE subject_type = 'agent_principal' AND subject_id = '${principalId}'::uuid
    ORDER BY created_at DESC LIMIT 1
  `))
  queryIsolatedPostgres(`
    UPDATE grants
    SET permissions = permissions || '[{"actionClass":"SPAWN_AGENT","resource":"*"}]'::jsonb
    WHERE id = '${grantId}'::uuid
      AND NOT (permissions @> '[{"actionClass":"SPAWN_AGENT","resource":"*"}]'::jsonb)
  `)
  if (scalarCount(`
    SELECT count(*) FROM grants WHERE id = '${grantId}'::uuid
      AND permissions @> '[{"actionClass":"SPAWN_AGENT","resource":"*"}]'::jsonb
  `) !== 1) {
    throw new Error('The Agent principal fixture grant does not include SPAWN_AGENT')
  }
}

test('@host Agent spawn uses CP logical MCP, approval retry, and child terminal link', async ({ page, request }) => {
  test.setTimeout(240_000)
  const pageErrors: string[] = []
  const apiFailures: string[] = []
  const browserChatRequests: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('requestfailed', (failed) => {
    if (failed.url().startsWith(CP_URL)) apiFailures.push(`${failed.method()} ${failed.url()}`)
  })
  page.on('request', (outgoing) => {
    if (outgoing.url().includes('/api/v1/chat')) browserChatRequests.push(outgoing.method())
  })

  const fakeHealth = await request.get(`${FAKE_LLM_URL}/health`)
  expect(fakeHealth.ok(), 'spawn fake LLM must be ready').toBeTruthy()
  expect((await fakeHealth.json() as { mode: string }).mode).toBe('spawn_agent')

  const owner = await registerJourneyUser(request, 'agent-spawn-host')
  const ownerMe = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: owner.headers })
  expect(ownerMe.ok(), await ownerMe.text()).toBeTruthy()
  const userId = requireUuid((await ownerMe.json() as { id: string }).id)
  const workspaceId = requireUuid(owner.workspaceId)
  const workspaceHeaders = { ...owner.headers, 'X-Workspace-Id': workspaceId }
  seedUserSpawnPermissions(userId, workspaceId)

  const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
    headers: workspaceHeaders,
    data: { name: 'CP MCP Spawn E2E' },
  })
  expect(principalResponse.status(), await principalResponse.text()).toBe(201)
  const principalId = requireUuid((await principalResponse.json() as { principalId: string }).principalId)
  addPrincipalSpawnGrant(principalId)

  const bindingResponse = await request.put(
    `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
    { headers: workspaceHeaders, data: { permissions: [{ actionClass: 'SPAWN_AGENT', resource: '*' }] } },
  )
  expect(bindingResponse.status(), await bindingResponse.text()).toBe(200)
  await ensureAgentWorkspaceBinding(workspaceId)

  seedPage(page, owner)
  await page.goto(`/workspace/${workspaceId}`, { waitUntil: 'load' })
  const createSession = page.getByTestId('workspace-create-session')
  await expect(createSession).toBeVisible({ timeout: 30_000 })
  await createSession.click()
  const principalPicker = page.getByTestId('workspace-agent-principal-select')
  await expect(principalPicker).toBeVisible()
  await principalPicker.selectOption(principalId)
  const sessionResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/sessions') && response.request().method() === 'POST',
  )
  await page.getByTestId('workspace-create-agent-session').click()
  const sessionResponse = await sessionResponsePromise
  expect(sessionResponse.status(), await sessionResponse.text()).toBe(201)
  const parentSessionId = requireUuid((await sessionResponse.json() as { id: string }).id)
  await expect(page).toHaveURL(workspaceChatPath(workspaceId, parentSessionId))
  await expect(page.getByTestId('chat-input')).toBeVisible()

  queryIsolatedPostgres(`UPDATE sessions SET approval_mode = 'manual' WHERE id = '${parentSessionId}'::uuid`)
  const sessionView = await request.get(`${CP_URL}/api/v1/sessions/${parentSessionId}`, { headers: workspaceHeaders })
  expect(sessionView.ok(), await sessionView.text()).toBeTruthy()
  expect((await sessionView.json() as { agentPrincipalId: string }).agentPrincipalId).toBe(principalId)

  let childReleaseNeeded = false
  try {
    const token = `spawn-${Date.now().toString(36)}`
    childReleaseNeeded = true
    await sendChat(page, `XIHE-E2E-SPAWN ${token}`)
    const approvalModal = page.locator('[data-testid="modal-content"]')
    await expect(approvalModal, 'spawn must use the existing MCP approval gate').toBeVisible({ timeout: 60_000 })
    await approvalModal.locator('[data-testid="approval-approve"]').click()
    await expect(approvalModal).toBeHidden({ timeout: 20_000 })

    await expect.poll(async () => {
      const stateResponse = await request.get(`${FAKE_LLM_URL}/__test/spawn-child-state`)
      if (!stateResponse.ok()) return -1
      return (await stateResponse.json() as { pending: number }).pending
    }, { timeout: 60_000, intervals: [250, 500, 1_000] }).toBe(1)

    const parentOperationId = requireUuid(queryIsolatedPostgres(
      `SELECT id FROM ledger_operations WHERE session_id = '${parentSessionId}'::uuid ORDER BY created_at DESC LIMIT 1`,
    ))
    const parentRunId = requireUuid(queryIsolatedPostgres(
      `SELECT run_id FROM ledger_operations WHERE id = '${parentOperationId}'::uuid`,
    ))
    const traceUrl = `${CP_URL}/api/v1/operations/${parentOperationId}`
    let parentItem: { source?: string; toolName?: string; status?: string; waitingOnRunId?: string | null } | undefined
    await expect.poll(async () => {
      const traceResponse = await request.get(traceUrl, { headers: workspaceHeaders })
      if (!traceResponse.ok()) return ''
      const trace = await traceResponse.json() as { items?: Array<typeof parentItem> }
      parentItem = trace.items?.find((item) => item?.source === 'agent' && item.toolName === 'spawn_agent')
      return parentItem?.waitingOnRunId ?? ''
    }, { timeout: 30_000, intervals: [250, 500, 1_000] }).not.toBe('')

    const childRunId = requireUuid(parentItem?.waitingOnRunId ?? '')
    const childSessionId = requireUuid(queryIsolatedPostgres(
      `SELECT session_id FROM chat_runs WHERE id = '${childRunId}'::uuid`,
    ))
    const childSessionResponse = await request.get(`${CP_URL}/api/v1/sessions/${childSessionId}`, {
      headers: workspaceHeaders,
    })
    expect(childSessionResponse.ok(), await childSessionResponse.text()).toBeTruthy()
    const childSession = await childSessionResponse.json() as {
      id: string; workspaceId: string; agentPrincipalId: string;
    }
    expect(childSession).toMatchObject({
      id: childSessionId,
      workspaceId,
      agentPrincipalId: principalId,
    })
    expect(scalarCount(
      `SELECT count(*) FROM sessions WHERE id = '${childSessionId}'::uuid `
        + `AND spawned_from_run_id = '${parentRunId}'::uuid AND kind = 'spawn'`,
    )).toBe(1)
    expect(scalarCount(
      `SELECT count(*) FROM audit_logs WHERE action = 'agent_spawn_created' AND resource_id = '${childSessionId}'`,
    )).toBe(1)

    const parentAssistant = page.locator('[data-slot="message"][data-align="start"]').last()
    await expect(parentAssistant).toContainText('SPAWN_PARENT_DONE', { timeout: 60_000 })
    const parentRunStatus = queryIsolatedPostgres(
      `SELECT status FROM chat_runs WHERE id = '${parentRunId}'::uuid`,
    )
    expect(parentRunStatus).toBe('succeeded')

    const releaseResponse = await request.post(`${FAKE_LLM_URL}/__test/release-spawn-child`)
    expect(releaseResponse.ok(), await releaseResponse.text()).toBeTruthy()
    expect((await releaseResponse.json() as { released: number }).released).toBe(1)
    childReleaseNeeded = false

    await expect.poll(async () => queryIsolatedPostgres(
      `SELECT status FROM chat_runs WHERE id = '${childRunId}'::uuid`,
    ), { timeout: 60_000, intervals: [250, 500, 1_000] }).toBe('succeeded')
    const childAssistantMessageId = requireUuid(queryIsolatedPostgres(
      `SELECT assistant_message_id FROM chat_runs WHERE id = '${childRunId}'::uuid`,
    ))
    await expect.poll(async () => JSON.parse(queryIsolatedPostgres(`
      SELECT coalesce(json_agg(json_build_object(
        'status', status,
        'waitingOnRunId', waiting_on_run_id,
        'resultRef', result_ref
      ) ORDER BY sequence)::text, '[]')
      FROM operation_items
      WHERE operation_id = '${parentOperationId}'::uuid
        AND kind = 'tool_call' AND source = 'agent' AND tool_name = 'spawn_agent'
    `)) as Array<{ status: string; waitingOnRunId: string | null; resultRef: string | null }>,
    { timeout: 30_000, intervals: [250, 500, 1_000] }).toEqual([{
      status: 'completed',
      waitingOnRunId: null,
      resultRef: childAssistantMessageId,
    }])

    const childMessagesResponse = await request.get(
      `${CP_URL}/api/v1/sessions/${childSessionId}/messages`, { headers: workspaceHeaders },
    )
    expect(childMessagesResponse.ok(), await childMessagesResponse.text()).toBeTruthy()
    const childMessages = await childMessagesResponse.json() as Array<{ role?: string; content?: string }>
    expect(childMessages.some((message) => message.role.toLowerCase() === 'assistant' && message.content?.includes('SPAWN_CHILD_DONE')))
      .toBe(true)
    expect(browserChatRequests).toContain('POST')
    expect(pageErrors).toEqual([])
    expect(apiFailures).toEqual([])

    await test.info().attach('agent-spawn-evidence.json', {
      body: Buffer.from(JSON.stringify({
        parentSessionId,
        parentOperationId,
        parentRunId,
        childSessionId,
        childRunId,
        principalId,
        browserChatRequests,
      }, null, 2)),
      contentType: 'application/json',
    })
  } finally {
    if (childReleaseNeeded) {
      const release = await request.post(`${FAKE_LLM_URL}/__test/release-spawn-child`).catch((cause) => {
        console.warn('Could not release fake spawn child during test cleanup', cause)
        return null
      })
      if (release && !release.ok()) {
        console.warn('Fake spawn child cleanup returned an error', release.status())
      }
    }
  }
})
