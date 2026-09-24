import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { CP_URL, registerJourneyUser, seedPage } from './helpers/journey'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

test.describe.configure({ retries: 0 })

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

function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error('Expected a UUID for an isolated database fixture')
  return value
}

function seedUserGrant(userIdValue: string, permissions: Array<{ actionClass: string; resource: string }>): void {
  const userId = requireUuid(userIdValue)
  const permissionJson = JSON.stringify(permissions).replaceAll("'", "''")
  queryIsolatedPostgres(`
    INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state)
    VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid,
            '${permissionJson}'::jsonb, 'direct', 'read')
  `)
}

function scalarCount(sql: string): number {
  const value = queryIsolatedPostgres(sql)
  if (!/^\d+$/.test(value)) throw new Error(`Expected a scalar count, received: ${value}`)
  return Number(value)
}

test('@host V6 Workspace Agent management uses CP grants and persists isolated caps/audit', async ({ page, request }, testInfo) => {
  const owner = await registerJourneyUser(request, 't44-agent-owner')
  const secondOwner = await registerJourneyUser(request, 't44-agent-second-owner')
  const ownerMeResponse = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: owner.headers })
  const secondMeResponse = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: secondOwner.headers })
  expect(ownerMeResponse.ok(), await ownerMeResponse.text()).toBe(true)
  expect(secondMeResponse.ok(), await secondMeResponse.text()).toBe(true)
  const ownerUserId = requireUuid((await ownerMeResponse.json() as { id: string }).id)
  const secondUserId = requireUuid((await secondMeResponse.json() as { id: string }).id)
  const workspaceA = requireUuid(owner.workspaceId)
  const workspaceB = requireUuid(secondOwner.workspaceId)

  seedUserGrant(ownerUserId, [
    { actionClass: 'CREATE_ACCOUNT', resource: '*' },
    { actionClass: 'MANAGE_WORKSPACE_AGENTS', resource: workspaceA },
  ])
  seedUserGrant(secondUserId, [
    { actionClass: 'MANAGE_WORKSPACE_AGENTS', resource: workspaceB },
  ])

  const pageErrors: string[] = []
  const apiRequestFailures: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('requestfailed', (failedRequest) => {
    if (failedRequest.url().startsWith(CP_URL)) {
      apiRequestFailures.push(`${failedRequest.method()} ${failedRequest.url()}`)
    }
  })
  seedPage(page, owner)
  await page.goto(`/workspace/${workspaceA}`, { waitUntil: 'load' })

  await page.getByTestId('workspace-toolbar-agents').click()
  const dialog = page.getByTestId('workspace-agent-management-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('暂无活动会话')).toHaveCount(0)

  await page.getByTestId('agent-principal-name').fill('T4.4 Persistent Agent')
  const createResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/agent-principals') && response.request().method() === 'POST',
  )
  await page.getByTestId('agent-principal-create').click()
  const createResponse = await createResponsePromise
  expect(createResponse.status()).toBe(201)
  const createdPrincipal = await createResponse.json() as { principalId: string }
  const principalId = requireUuid(createdPrincipal.principalId)
  await expect(page.getByTestId('unbound-agent-principal')).toContainText(principalId)
  const principalGrantsBefore = queryIsolatedPostgres(
    `SELECT source || ':' || permissions::text FROM grants `
      + `WHERE subject_type = 'agent_principal' AND subject_id = '${principalId}'::uuid ORDER BY source`,
  )

  await page.getByTestId('agent-cap-read').check()
  await page.getByTestId('agent-resource-read').fill('src/*')
  const bindResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents/${principalId}`)
      && response.request().method() === 'PUT',
  )
  await page.getByTestId('agent-principal-bind').click()
  expect((await bindResponsePromise).status()).toBe(200)

  const bindingA = page.getByTestId(`workspace-agent-${principalId}`)
  await expect(bindingA).toContainText('读取')
  await expect(bindingA).toContainText('src/*')
  const refreshPromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents`)
      && response.request().method() === 'GET',
  )
  await page.getByTestId('workspace-agent-refresh').click()
  expect((await refreshPromise).status()).toBe(200)
  await expect(bindingA).toContainText('src/*')

  const bindBResponse = await request.put(
    `${CP_URL}/api/v1/workspaces/${workspaceB}/agents/${principalId}`,
    { headers: secondOwner.headers, data: { permissions: [{ actionClass: 'write', resource: 'docs/*' }] } },
  )
  expect(bindBResponse.status(), await bindBResponse.text()).toBe(200)

  await bindingA.getByTestId(`workspace-agent-edit-cap-${principalId}`).click()
  await page.getByTestId('agent-cap-write').check()
  await page.getByTestId('agent-resource-write').fill('reports/*')
  const capSavePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents/${principalId}`)
      && response.request().method() === 'PUT',
  )
  await bindingA.getByTestId(`workspace-agent-save-cap-${principalId}`).click()
  expect((await capSavePromise).status()).toBe(200)
  await expect(bindingA).toContainText('reports/*')
  await page.screenshot({ path: testInfo.outputPath('workspace-agent-cap-persisted.png') })

  await page.getByTestId('workspace-agent-refresh').click()
  await expect(bindingA).toContainText('reports/*')
  const bindingBResponse = await request.get(`${CP_URL}/api/v1/workspaces/${workspaceB}/agents`, {
    headers: secondOwner.headers,
  })
  expect(bindingBResponse.status()).toBe(200)
  const bindingsB = await bindingBResponse.json() as Array<{ principalId: string; permissions: Array<{ actionClass: string; resource?: string }> }>
  const bindingB = bindingsB.find((binding) => binding.principalId === principalId)
  expect(bindingB?.permissions).toEqual([{ actionClass: 'write', resource: 'docs/*' }])
  const principalGrantsAfter = queryIsolatedPostgres(
    `SELECT source || ':' || permissions::text FROM grants `
      + `WHERE subject_type = 'agent_principal' AND subject_id = '${principalId}'::uuid ORDER BY source`,
  )
  expect(principalGrantsAfter).toBe(principalGrantsBefore)

  await page.reload({ waitUntil: 'load' })
  await page.getByTestId('workspace-toolbar-agents').click()
  const reloadedBinding = page.getByTestId(`workspace-agent-${principalId}`)
  await expect(reloadedBinding).toContainText('reports/*')

  const historicalSessionResponse = await request.post(`${CP_URL}/api/v1/sessions`, {
    headers: owner.headers,
    data: { title: 'History before unbind', agentPrincipalId: principalId },
  })
  expect(historicalSessionResponse.status(), await historicalSessionResponse.text()).toBe(201)
  const historicalSession = await historicalSessionResponse.json() as { id: string }
  const historicalSessionId = requireUuid(historicalSession.id)

  const unbindButton = page.getByTestId(`workspace-agent-unbind-${principalId}`)
  await unbindButton.click()
  await expect(unbindButton).toContainText('再次点击确认解绑')
  const deleteResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents/${principalId}`)
      && response.request().method() === 'DELETE',
  )
  await unbindButton.click()
  expect((await deleteResponsePromise).status()).toBe(204)
  await expect(page.getByText('此工作区尚未绑定 Agent')).toBeVisible()

  expect(scalarCount(`SELECT count(*) FROM workspace_agents WHERE principal_id = '${principalId}'::uuid AND workspace_id = '${workspaceA}'::uuid`)).toBe(0)
  expect(scalarCount(`SELECT count(*) FROM workspace_agents WHERE principal_id = '${principalId}'::uuid AND workspace_id = '${workspaceB}'::uuid`)).toBe(1)
  expect(scalarCount(`SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_created' AND user_id = '${ownerUserId}'::uuid AND resource_id = '${principalId}'`)).toBe(1)
  expect(scalarCount(`SELECT count(*) FROM audit_logs WHERE action = 'workspace_agent_bound' AND user_id = '${ownerUserId}'::uuid AND workspace_id = '${workspaceA}'::uuid AND resource_id = '${principalId}'`)).toBe(1)
  expect(scalarCount(`SELECT count(*) FROM audit_logs WHERE action = 'workspace_agent_cap_updated' AND user_id = '${ownerUserId}'::uuid AND workspace_id = '${workspaceA}'::uuid AND resource_id = '${principalId}'`)).toBe(1)
  expect(scalarCount(`SELECT count(*) FROM audit_logs WHERE action = 'workspace_agent_unbound' AND user_id = '${ownerUserId}'::uuid AND workspace_id = '${workspaceA}'::uuid AND resource_id = '${principalId}'`)).toBe(1)

  await page.getByTestId('modal-content').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByTestId('workspace-agent-management-dialog')).toHaveCount(0)
  const attemptedSessionPosts: string[] = []
  page.on('request', (outgoingRequest) => {
    if (outgoingRequest.url().endsWith('/api/v1/sessions') && outgoingRequest.method() === 'POST') {
      attemptedSessionPosts.push(outgoingRequest.url())
    }
  })
  const emptyBindingReload = page.waitForResponse((response) =>
    response.url().endsWith(`/api/v1/workspaces/${workspaceA}/agents`)
      && response.request().method() === 'GET',
  )
  await page.goto(`/workspace/${workspaceA}?newChat=1`, { waitUntil: 'load' })
  expect((await emptyBindingReload).status()).toBe(200)
  await expect(page.getByText('此工作区尚未绑定 Agent')).toBeVisible()
  expect(attemptedSessionPosts).toEqual([])

  const unboundSessionAttempt = await request.post(`${CP_URL}/api/v1/sessions`, {
    headers: owner.headers,
    data: { title: 'Must stay uncreated', agentPrincipalId: principalId },
  })
  expect(unboundSessionAttempt.status()).toBe(403)
  // History kept, no new Session: exactly the pre-unbind row survives.
  expect(scalarCount(`SELECT count(*) FROM sessions WHERE agent_principal_id = '${principalId}'::uuid`)).toBe(1)
  const preservedHistory = await request.get(`${CP_URL}/api/v1/sessions/${historicalSessionId}`, {
    headers: owner.headers,
  })
  expect(preservedHistory.status()).toBe(200)
  expect((await preservedHistory.json() as { agentPrincipalId: string }).agentPrincipalId).toBe(principalId)

  queryIsolatedPostgres(`UPDATE grants SET permissions = '[{"actionClass":"CREATE_ACCOUNT","resource":"*"}]'::jsonb `
    + `WHERE subject_type = 'user' AND subject_id = '${ownerUserId}'::uuid AND source = 'direct'`)
  await page.getByTestId('workspace-toolbar-agents').click()
  await page.getByTestId('agent-principal-name').fill('Create only, no bind permission')
  const createOnlyResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith('/api/v1/agent-principals') && response.request().method() === 'POST',
  )
  await page.getByTestId('agent-principal-create').click()
  const createOnlyResponse = await createOnlyResponsePromise
  expect(createOnlyResponse.status()).toBe(201)
  const unboundOnly = await createOnlyResponse.json() as { principalId: string }
  const unboundOnlyId = requireUuid(unboundOnly.principalId)
  await page.getByTestId('agent-principal-bind').click()
  await expect(page.getByRole('alert')).toContainText('MANAGE_WORKSPACE_AGENTS permission is required')
  await expect(page.getByTestId('unbound-agent-principal')).toContainText(unboundOnlyId)
  expect(scalarCount(`SELECT count(*) FROM workspace_agents WHERE principal_id = '${unboundOnlyId}'::uuid`)).toBe(0)
  expect(scalarCount(`SELECT count(*) FROM audit_logs WHERE action = 'agent_principal_created' AND user_id = '${ownerUserId}'::uuid AND resource_id = '${unboundOnlyId}'`)).toBe(1)
  expect(scalarCount(`SELECT count(*) FROM audit_logs WHERE action LIKE 'workspace_agent\\_%' ESCAPE '\\' `
    + `AND user_id = '${ownerUserId}'::uuid AND resource_id = '${unboundOnlyId}'`)).toBe(0)

  expect(pageErrors).toEqual([])
  expect(apiRequestFailures).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('workspace-agent-unbound.png') })
})
