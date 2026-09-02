import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { generateE2EPassword } from './helpers/password'

const RUNTIME_URL = `http://localhost:${process.env.XIHE_RUNTIME_PORT || '12633'}`
const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN
if (!SERVICE_TOKEN) throw new Error('XIHE_CP_API_TOKEN must be set for real E2E')
const TEST_PASSWORD = generateE2EPassword()

test.describe('@host Runtime M1 — dev:host E2E via Playwright CLI', () => {
  test('targeted file operation materializes one coding Sandbox, then delete preserves the contract', async ({ request }) => {
    const register = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `runtime-m1-${Date.now()}@test.com`, password: TEST_PASSWORD, name: 'Runtime M1' },
    })
    expect(register.ok()).toBeTruthy()
    const auth = await register.json()
    const wsId = auth.workspaceId

    // Session/auth creation only creates logical Workspace state.
    const before = await request.get(`${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/status`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    })
    expect(before.status()).toBe(404)

    // The first targeted file operation performs materialization.
    const filePath = 'hello-m1.txt'
    const fileContent = `hello-m1-${wsId}`
    const writeRes = await request.post(
      `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/files/write/${encodeURIComponent(filePath)}`,
      {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
        data: Buffer.from(fileContent, 'utf-8'),
      },
    )
    expect(writeRes.ok()).toBeTruthy()

    const readRes = await request.post(
      `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/files/read`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SERVICE_TOKEN}`,
        },
        data: { path: filePath },
      },
    )
    expect(readRes.ok()).toBeTruthy()
    const readBody = await readRes.json()
    // read returns {content, truncated} or similar
    const content = readBody.content ?? readBody.data ?? ''
    expect(content).toContain(fileContent)

    // Delete removes the ephemeral Sandbox, not WorkspaceStorage.
    const delRes = await request.post(`${RUNTIME_URL}/internal/v1/runtime/workspaces/delete`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_TOKEN}`,
      },
      data: { workspaceId: wsId },
    })
    expect(delRes.ok()).toBeTruthy()
    const delBody = await delRes.json()
    expect(delBody.status).toBe('ok')

    // The materialized runtime entry is gone after delete.
    const afterDel = await request.post(
      `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/files/read`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SERVICE_TOKEN}`,
        },
        data: { path: filePath },
      },
    )
    expect(afterDel.status()).toBe(404)
  })

  test('direct Runtime create acknowledges a strict logical Workspace without materializing it', async ({ request }) => {
    const wsId = randomUUID()
    const createRes = await request.post(`${RUNTIME_URL}/internal/v1/runtime/workspaces`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_TOKEN}`,
      },
      data: {
        workspaceId: wsId,
        workspacePath: 'C:\\tmp\\unused',
        storageRef: wsId,
        profile: 'strict',
      },
    })
    expect(createRes.ok()).toBeTruthy()
    const body = await createRes.json()
    expect(body.status).toBe('ok')

    const statusRes = await request.get(`${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/status`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    })
    expect(statusRes.status()).toBe(404)

    const deleteRes = await request.post(`${RUNTIME_URL}/internal/v1/runtime/workspaces/delete`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_TOKEN}`,
      },
      data: { workspaceId: wsId },
    })
    expect(deleteRes.ok()).toBeTruthy()
  })
})
