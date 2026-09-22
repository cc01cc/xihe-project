import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../.local/evidence/plan0350-workspace-events')

// PLAN-0350 M3 / V1–V7：真实 host 的 Workspace 文件事件链路。
// 链路：Runtime host notify watcher → CP internal ingress → Workspace SSE → UI 文件树刷新。
// 跑法：node scripts/e2e-host-detached.mjs e2e/real/plan0350-workspace-events.spec.ts --llm-mode=mock
test.describe('@host PLAN-0350 workspace file events', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  let ownerAuth: string
  let otherAuth: string
  let wsId = ''
  let hostPath = ''

  async function registerUser(request: import('@playwright/test').APIRequestContext, tag: string) {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const res = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `plan0350-${tag}-${Date.now()}@test.com`, password, name: `Plan0350 ${tag}` },
    })
    expect([200, 201], `register ${tag} failed: ${res.status()} ${await res.text()}`).toContain(res.status())
    const body = await res.json()
    return { accessToken: body.accessToken as string, refreshToken: body.refreshToken as string, workspaceId: body.workspaceId as string }
  }

  test.beforeAll(async ({ request }) => {
    const owner = await registerUser(request, 'owner')
    const other = await registerUser(request, 'other')
    otherAuth = other.accessToken
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    const hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT || os.tmpdir()
    hostPath = path.join(hostRoot, `xihe-e2e-0350-${Date.now()}`)
    mkdirSync(hostPath, { recursive: true })
    writeFileSync(path.join(hostPath, 'seed.md'), '# seed\n')

    const ownerHeaders = { Authorization: `Bearer ${owner.accessToken}`, 'Content-Type': 'application/json' }
    // The access token carries the user's default workspace (auto-created at register).
    // Remove it so the direct-attach workspace becomes that default, then refresh the
    // token: MCP/file operations require the token workspace to match the request.
    await request.delete(`${CP_URL}/api/v1/workspaces/${owner.workspaceId}`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    })

    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
      headers: { ...ownerHeaders, 'Idempotency-Key': `plan0350-${Date.now()}` },
      data: { name: 'Plan0350 Events', storageMode: 'direct_attach', hostPath, executionMode: 'windows-host' },
    })
    expect(created.ok(), `workspace create failed: ${created.status()} ${await created.text()}`).toBeTruthy()
    wsId = String((await created.json()).id ?? '')
    expect(wsId).toBeTruthy()

    const refreshed = await request.post(`${CP_URL}/api/v1/auth/refresh`, {
      data: { refreshToken: owner.refreshToken },
    })
    expect(refreshed.ok(), `refresh failed: ${refreshed.status()} ${await refreshed.text()}`).toBeTruthy()
    const refreshedBody = await refreshed.json()
    expect(String(refreshedBody.workspaceId), 'refreshed token must be bound to the direct-attach workspace').toBe(wsId)
    ownerAuth = refreshedBody.accessToken
  })

  function seedPage(page: import('@playwright/test').Page) {
    page.addInitScript((t) => localStorage.setItem('xihe-token', t), ownerAuth)
    page.addInitScript(
      (raw) => localStorage.setItem('xihe-user', raw),
      JSON.stringify({ id: 'e2e-user', email: 'plan0350@test.com', name: 'Plan0350', workspaceId: wsId }),
    )
    page.addInitScript((ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)), {
      id: wsId,
      name: 'Plan0350 Events',
    })
    page.addInitScript((id) => localStorage.setItem('xihe-workspace-id', id), wsId)
  }

  /** Subscribe to the Workspace SSE from the page (relative URL → dev proxy, Bearer header). */
  async function startSubscriber(page: import('@playwright/test').Page, workspaceId: string) {
    await page.evaluate((id) => {
      localStorage.setItem('xihe-workspace-id', id)
      const token = localStorage.getItem('xihe-token') ?? ''
      const w = window as unknown as { __ws: { events: string; state: string; status: number } }
      w.__ws = { events: '', state: 'connecting', status: 0 }
      void (async () => {
        try {
          const res = await fetch(`/api/v1/workspaces/${id}/events`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          })
          w.__ws.status = res.status
          if (!res.body) {
            w.__ws.state = 'no-body'
            return
          }
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            w.__ws.events += decoder.decode(value, { stream: true })
          }
          w.__ws.state = 'closed'
        } catch (error) {
          w.__ws.state = `error:${String(error)}`
        }
      })()
    }, workspaceId)
  }

  function readSubscriber(page: import('@playwright/test').Page) {
    return page.evaluate(() => (window as unknown as { __ws: { events: string; state: string; status: number } }).__ws)
  }

  test('delivers a relative-path file_changed event after an external host write', async ({ page, request }) => {
    // Unauthorized subscribers fail closed (V1).
    const denied = await request.get(`${CP_URL}/api/v1/workspaces/${wsId}/events`, {
      headers: { Authorization: `Bearer ${otherAuth}` },
    })
    expect(denied.status(), 'non-member must not subscribe').toBe(404)

    seedPage(page)
    await page.goto(`/workspace/${wsId}/environment`, { waitUntil: 'domcontentloaded' })
    await startSubscriber(page, wsId)
    await expect
      .poll(async () => (await readSubscriber(page)).status, { timeout: 20000 })
      .toBe(200)

    // Ensure the workspace (installs the Runtime host watcher) before the external write.
    const materialized = await request.post(`${CP_URL}/api/v1/workspaces/${wsId}/materialize`, {
      headers: { Authorization: `Bearer ${ownerAuth}` },
    })
    expect([200, 202], `materialize failed: ${materialized.status()} ${await materialized.text()}`).toContain(
      materialized.status(),
    )

    const fileName = `live-${Date.now()}.md`
    writeFileSync(path.join(hostPath, fileName), '# live\n')

    await expect
      .poll(async () => (await readSubscriber(page)).events, { timeout: 30000 })
      .toContain('file_changed')
    const events = (await readSubscriber(page)).events
    expect(events).toContain(fileName)
    // V3: only Workspace-relative POSIX hints — no host root, drive letter or backslash path.
    expect(events).not.toContain(hostPath)
    expect(events).not.toMatch(/[A-Za-z]:\\\\/)
    expect(events).toMatch(/sequence/)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'sse-file-changed.png'), fullPage: true })
  })

  test('refreshes the workspace file tree in the real UI after an external write', async ({ page }) => {
    seedPage(page)
    await page.goto(`/workspace/${wsId}`, { waitUntil: 'load' })
    await expect(page.locator('[data-testid="workspace-event-status"]')).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('seed.md', { exact: true }).first()).toBeVisible({ timeout: 20000 })

    const liveName = `ui-live-${Date.now()}.md`
    writeFileSync(path.join(hostPath, liveName), '# ui live\n')
    await expect(page.getByText(liveName, { exact: true }).first()).toBeVisible({ timeout: 30000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'tree-refresh.png'), fullPage: true })
  })

  test('closes the live subscription when the workspace is deleted', async ({ page, request }) => {
    const hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT || os.tmpdir()
    const tempDir = path.join(hostRoot, `xihe-e2e-0350-del-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
      headers: {
        Authorization: `Bearer ${ownerAuth}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `plan0350-del-${Date.now()}`,
      },
      data: { name: 'Plan0350 Delete', storageMode: 'direct_attach', hostPath: tempDir, executionMode: 'windows-host' },
    })
    expect(created.ok(), `create failed: ${created.status()} ${await created.text()}`).toBeTruthy()
    const delWs = String((await created.json()).id ?? '')

    seedPage(page)
    await page.goto(`/workspace/${wsId}/environment`, { waitUntil: 'domcontentloaded' })
    await startSubscriber(page, delWs)
    await expect.poll(async () => (await readSubscriber(page)).status, { timeout: 20000 }).toBe(200)

    const deleted = await request.delete(`${CP_URL}/api/v1/workspaces/${delWs}`, {
      headers: { Authorization: `Bearer ${ownerAuth}` },
    })
    expect([200, 204], `delete failed: ${deleted.status()}`).toContain(deleted.status())

    // V6: the deletion closes the live subscription (the reader reaches EOF).
    await expect.poll(async () => (await readSubscriber(page)).state, { timeout: 30000 }).toBe('closed')
  })
})
