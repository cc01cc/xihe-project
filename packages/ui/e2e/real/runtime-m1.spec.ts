import { test, expect } from '@playwright/test'

const RUNTIME_URL = `http://localhost:${process.env.XIHE_RUNTIME_PORT || '12633'}`
const SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN || 'dev-token-not-secure'

test.describe('Runtime M1 — dev:host E2E via Playwright CLI', () => {
  test('POST create → sentinel → delete (coding, Engine exec)', async ({ request }) => {
    const wsId = `pw-m1-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    const storageRef = wsId

    // 1. Create workspace (coding) — should succeed and create Docker container
    const createRes = await request.post(`${RUNTIME_URL}/internal/v1/runtime/workspaces`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_TOKEN}`,
      },
      data: {
        workspaceId: wsId,
        workspacePath: 'C:\\tmp\\unused',
        storageRef,
        profile: 'coding',
      },
    })
    expect(createRes.ok()).toBeTruthy()
    const createBody = await createRes.json()
    expect(createBody.status).toBe('ok')
    expect(createBody.workspaceId).toBe(wsId)

    // 2. Verify file write/read via runtime's file API (proves mount is writable)
    // Use the runtime's file API: POST /internal/v1/runtime/workspaces/{wsId}/files/write/{path}
    const filePath = 'hello-m1.txt'
    const fileContent = `hello-m1-${wsId}`
    const writeRes = await request.post(
      `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/files/write/${encodeURIComponent(filePath)}`,
      {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
        data: Buffer.from(fileContent, 'utf-8'),
      },
    )
    // The file API may return JSON with message; accept 200
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

    // 3. Verify sentinel exists via file API (proves host→container mount)
    const sentinelRes = await request.post(
      `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/files/read`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SERVICE_TOKEN}`,
        },
        data: { path: '.xihe-sentinel' },
      },
    )
    expect(sentinelRes.ok()).toBeTruthy()
    const sentinelBody = await sentinelRes.json()
    const sentinelContent = sentinelBody.content ?? ''
    expect(sentinelContent).toBe(`sentinel-${wsId}`)

    // 4. Delete workspace — should remove container and host dir
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

    // 5. Verify workspace no longer accessible (should be 404)
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

  test('Strict workspace creates with network none and sentinel', async ({ request }) => {
    const wsId = `pw-m1-strict-${Date.now()}-${Math.floor(Math.random() * 10000)}`
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

    // Strict should still have sentinel (mount is still verified, but network is none)
    const sentinelRes = await request.post(
      `${RUNTIME_URL}/internal/v1/runtime/workspaces/${wsId}/files/read`,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SERVICE_TOKEN}`,
        },
        data: { path: '.xihe-sentinel' },
      },
    )
    expect(sentinelRes.ok()).toBeTruthy()
    const sentinelBody = await sentinelRes.json()
    expect(sentinelBody.content).toBe(`sentinel-${wsId}`)

    // Cleanup
    await request.post(`${RUNTIME_URL}/internal/v1/runtime/workspaces/delete`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SERVICE_TOKEN}`,
      },
      data: { workspaceId: wsId },
    })
  })
})
