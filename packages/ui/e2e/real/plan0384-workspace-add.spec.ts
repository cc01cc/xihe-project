import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../.local/evidence/plan0384-add-workspace')

// PLAN-0384 M3 / V1–V4, V9–V12：真实浏览器完成「添加 Workspace」全流程。
// 链路：工具栏入口 → source browser 选目录 → 真实 capability preflight → 执行模式卡片
// → 确认摘要 → POST /api/v1/workspaces → Environment ready → 模式切换。
// 跑法：node scripts/e2e-host-detached.mjs e2e/real/plan0384-workspace-add.spec.ts --llm-mode=mock
test.describe('@host PLAN-0384 workspace add flow', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  let sharedAuth: string
  let seedWs = ''
  let hostRoot = ''
  let addDir = ''

  test.beforeAll(async ({ request }) => {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `plan0384-add-${Date.now()}@test.com`, password, name: 'Plan0384Add' },
    })
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(reg.status())
    sharedAuth = (await reg.json()).accessToken
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT || os.tmpdir()
    addDir = path.join(hostRoot, `xihe-e2e-0384-${Date.now()}`)
    mkdirSync(addDir, { recursive: true })

    // Seed an existing workspace so the toolbar entry (not the empty state) is exercised.
    const seedDir = path.join(hostRoot, `xihe-e2e-0384-seed-${Date.now()}`)
    mkdirSync(seedDir, { recursive: true })
    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
      headers: {
        Authorization: `Bearer ${sharedAuth}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `plan0384-seed-${Date.now()}`,
      },
      data: { name: 'Plan0384 Seed', storageMode: 'direct_attach', hostPath: seedDir, executionMode: 'windows-host' },
    })
    expect(created.ok(), `seed workspace failed: ${created.status()} ${await created.text()}`).toBeTruthy()
    seedWs = String((await created.json()).id ?? '')
    expect(seedWs).toBeTruthy()
  })

  function seedPage(page: import('@playwright/test').Page) {
    page.addInitScript((t) => localStorage.setItem('xihe-token', t), sharedAuth)
    page.addInitScript(
      (raw) => localStorage.setItem('xihe-user', raw),
      JSON.stringify({ id: 'e2e-user', email: 'plan0384@test.com', name: 'Plan0384', workspaceId: seedWs }),
    )
    page.addInitScript((ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)), {
      id: seedWs,
      name: 'Plan0384 Seed',
    })
    page.addInitScript((id) => localStorage.setItem('xihe-workspace-id', id), seedWs)
  }

  test('preflight reports real capability for both Windows backends', async ({ request }) => {
    for (const executionMode of ['windows-mxc', 'windows-host']) {
      const res = await request.post(`${CP_URL}/api/v1/workspaces/capabilities/preflight`, {
        headers: { Authorization: `Bearer ${sharedAuth}`, 'Content-Type': 'application/json' },
        data: { storageMode: 'direct_attach', hostPath: addDir, executionMode },
      })
      expect(res.ok(), `preflight ${executionMode} failed: ${res.status()} ${await res.text()}`).toBeTruthy()
      const body = await res.json()
      expect(body.contractVersion).toBe('v1')
      expect(body.executionMode).toBe(executionMode)
      expect(body.available, JSON.stringify(body)).toBe(true)
      if (executionMode === 'windows-mxc') expect(body.maturity).toBe('experimental')
    }
  })

  test('adds a direct-attach workspace through the source browser and shows real capability', async ({ page }) => {
    seedPage(page)
    await page.goto(`/workspace/${seedWs}`)

    const createRequest = page.waitForRequest(
      (req) => req.url().endsWith('/api/v1/workspaces') && req.method() === 'POST',
    )

    await page.locator('[data-testid="workspace-toolbar-add"]').click()
    await expect(page.locator('[data-testid="workspace-create-dialog"]')).toBeVisible()

    // V1: directory selection goes through the Runtime-visible source browser (no File.path).
    await page.locator('[data-testid="workspace-storage-direct"]').click()
    await page.locator('[data-testid="workspace-source-path"]').fill(addDir)
    await page.locator('[data-testid="workspace-source-read"]').click()
    await expect(page.locator('[data-testid="workspace-source-browser"]')).toBeVisible()
    await page.locator('[data-testid="workspace-source-use"]').click()

    // V2: execution-mode cards read the real preflight result.
    await expect(page.locator('[data-testid="workspace-execution-mxc-status"]')).toContainText('可用', {
      timeout: 20000,
    })
    const dockerCard = page.locator('[data-testid="workspace-execution-mode-docker"]')
    await expect(dockerCard).toBeDisabled()
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'execution-mode-cards.png'), fullPage: true })

    await page.locator('[data-testid="workspace-execution-next"]').click()
    await page.locator('[data-testid="workspace-create-name"]').fill(`Plan0384 Direct ${Date.now()}`)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'confirm-summary.png'), fullPage: true })
    await page.locator('[data-testid="workspace-create-submit"]').click()

    const request = await createRequest
    const payload = request.postDataJSON() as Record<string, unknown>
    expect(payload.storageMode).toBe('direct_attach')
    expect(payload.executionMode).toBe('windows-mxc')
    expect(payload.hostPath).toBe(addDir)
    expect(request.headers()['idempotency-key']).toBeTruthy()

    // V8: the new workspace is selected and its environment becomes readable.
    await expect(page.locator('[data-testid="workspace-create-dialog"]')).toBeHidden({ timeout: 20000 })
    await page.goto(`/workspace/${seedWs}/environment`)
    await expect(page.locator('[data-testid="workspace-environment-heading"]')).toBeVisible()
  })

  test('switches the execution mode to windows-host from the environment page', async ({ page, request }) => {
    // Create a dedicated workspace so the switch does not disturb the shared seed.
    const switchDir = path.join(hostRoot, `xihe-e2e-0384-switch-${Date.now()}`)
    mkdirSync(switchDir, { recursive: true })
    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
      headers: {
        Authorization: `Bearer ${sharedAuth}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `plan0384-switch-${Date.now()}`,
      },
      data: { name: 'Plan0384 Switch', storageMode: 'direct_attach', hostPath: switchDir, executionMode: 'windows-mxc' },
    })
    expect(created.ok(), `switch workspace failed: ${created.status()} ${await created.text()}`).toBeTruthy()
    const wsId = String((await created.json()).id ?? '')

    seedPage(page)
    await page.goto(`/workspace/${wsId}/environment`)
    const select = page.locator('[data-testid="workspace-execution-mode"]')
    await expect(select).toBeVisible({ timeout: 20000 })
    await select.selectOption('windows-host')
    await expect(select).toHaveValue('windows-host', { timeout: 20000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'execution-mode-switch.png'), fullPage: true })
  })

  test('create API rejects invalid combinations and dedupes idempotency keys', async ({ request }) => {
    const headers = { Authorization: `Bearer ${sharedAuth}`, 'Content-Type': 'application/json' }
    const create = (body: Record<string, unknown>, key = `plan0384-invalid-${Date.now()}-${Math.random()}`) =>
      request.post(`${CP_URL}/api/v1/workspaces`, { headers: { ...headers, 'Idempotency-Key': key }, data: body })

    // direct-attach requires hostPath.
    expect((await create({ name: 'no-path', storageMode: 'direct_attach', executionMode: 'windows-host' })).status()).toBe(400)
    // managed import must not receive hostPath.
    expect((await create({ name: 'managed-path', storageMode: 'managed_import', hostPath: addDir })).status()).toBe(400)
    // Windows modes must not receive profile.
    expect(
      (await create({ name: 'win-profile', storageMode: 'direct_attach', hostPath: addDir, executionMode: 'windows-host', profile: 'coding' }))
        .status(),
    ).toBe(400)
    // managed_import + windows mode is not a valid v1 combination.
    expect((await create({ name: 'managed-win', storageMode: 'managed_import', executionMode: 'windows-host' })).status()).toBe(400)

    // Replaying the same Idempotency-Key must not create a second workspace.
    const key = `plan0384-idem-${Date.now()}`
    const body = { name: `Plan0384 Idem ${Date.now()}`, storageMode: 'direct_attach', hostPath: addDir, executionMode: 'windows-host' }
    const first = await create(body, key)
    expect(first.ok(), `first create failed: ${first.status()} ${await first.text()}`).toBeTruthy()
    const firstId = String((await first.json()).id ?? '')
    const second = await create(body, key)
    expect([200, 201]).toContain(second.status())
    expect(String((await second.json()).id ?? '')).toBe(firstId)
  })

  test('execution-mode switch is refused for a non-member', async ({ request }) => {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `plan0384-outsider-${Date.now()}@test.com`, password, name: 'Outsider' },
    })
    expect([200, 201]).toContain(reg.status())
    const outsider = (await reg.json()).accessToken as string

    const res = await request.patch(`${CP_URL}/api/v1/workspaces/${seedWs}/execution-mode`, {
      headers: { Authorization: `Bearer ${outsider}`, 'Content-Type': 'application/json' },
      data: { executionMode: 'windows-host' },
    })
    expect([403, 404], `non-member must not switch: ${res.status()} ${await res.text()}`).toContain(res.status())
  })

  test('reload keeps the workspace usable and a missing host directory is refused', async ({ page, request }) => {
    seedPage(page)
    await page.goto(`/workspace/${seedWs}/environment`)
    await expect(page.locator('[data-testid="workspace-environment-heading"]')).toBeVisible({ timeout: 20000 })
    await page.reload()
    await expect(page.locator('[data-testid="workspace-environment-heading"]')).toBeVisible({ timeout: 20000 })

    const missing = await request.post(`${CP_URL}/api/v1/workspaces`, {
      headers: {
        Authorization: `Bearer ${sharedAuth}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `plan0384-missing-${Date.now()}`,
      },
      data: {
        name: 'Plan0384 Missing',
        storageMode: 'direct_attach',
        hostPath: path.join(hostRoot, `does-not-exist-${Date.now()}`),
        executionMode: 'windows-host',
      },
    })
    expect(missing.ok(), `missing directory must not silently succeed: ${missing.status()} ${await missing.text()}`).toBeFalsy()
    expect([400, 404, 409, 422, 502, 503]).toContain(missing.status())
  })

  test('add dialog stays usable on a mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    seedPage(page)
    await page.goto(`/workspace/${seedWs}`)
    // Narrow viewports reach the creation entry through the Files sheet.
    await page.locator('[data-testid="workspace-toolbar-files-mobile"]').click()
    await page.locator('[data-testid="mobile-workspace-add"]').click()
    await expect(page.locator('[data-testid="workspace-create-dialog"]')).toBeVisible({ timeout: 15000 })
    await page.locator('[data-testid="workspace-storage-direct"]').click()
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'mobile-source-step.png'), fullPage: true })
    const box = await page.locator('[data-testid="workspace-create-dialog"]').boundingBox()
    expect(box, 'dialog must render').toBeTruthy()
    expect(box!.width).toBeLessThanOrEqual(390)
  })
})
