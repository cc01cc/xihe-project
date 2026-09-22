import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'
import { actionableErrors, collectPageErrors } from './helpers/console'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../.local/evidence/plan0384-mxc-unavailable')

/**
 * PLAN-0384 V4 / T3.2: the MXC-unavailable branch must be exercised against the REAL backend.
 *
 * This spec requires a host stack booted with MXC unavailable, e.g.
 *   $env:XIHE_MXC_EXECUTABLE='C:\nonexistent\wxc-exec.exe'
 *   node scripts/e2e-host.mjs --persistent --llm-mode=mock
 *   $env:XIHE_E2E_EXTERNAL_SERVER='1'; node scripts/e2e-host.mjs --llm-mode=mock \
 *     e2e/real/plan0384-mxc-unavailable.spec.ts
 */
test.describe('@host PLAN-0384 MXC unavailable branch', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180000)

  let auth: string
  let seedWs = ''
  let hostRoot = ''
  let targetDir = ''
  let pageErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    pageErrors = collectPageErrors(page)
  })

  test.afterEach(async () => {
    expect(actionableErrors(pageErrors), pageErrors.join('\n')).toEqual([])
  })

  test.beforeAll(async ({ request }) => {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `plan0384-mxc-off-${Date.now()}@test.com`, password, name: 'Plan0384 MxcOff' },
    })
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(reg.status())
    const body = await reg.json()
    auth = body.accessToken as string
    mkdirSync(EVIDENCE_DIR, { recursive: true })

    hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT || os.tmpdir()
    targetDir = path.join(hostRoot, `xihe-e2e-0384-mxcoff-${Date.now()}`)
    mkdirSync(targetDir, { recursive: true })

    // Rebind the token so the seed workspace is the user's default context.
    await request.delete(`${CP_URL}/api/v1/workspaces/${body.workspaceId}`, {
      headers: { Authorization: `Bearer ${auth}` },
    })
    const seedDir = path.join(hostRoot, `xihe-e2e-0384-mxcoff-seed-${Date.now()}`)
    mkdirSync(seedDir, { recursive: true })
    const created = await request.post(`${CP_URL}/api/v1/workspaces`, {
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json', 'Idempotency-Key': `mxc-off-seed-${Date.now()}` },
      data: { name: 'Plan0384 MxcOff Seed', storageMode: 'direct_attach', hostPath: seedDir, executionMode: 'windows-host' },
    })
    expect(created.ok(), `seed failed: ${created.status()} ${await created.text()}`).toBeTruthy()
    seedWs = String((await created.json()).id ?? '')
    const refreshed = await request.post(`${CP_URL}/api/v1/auth/refresh`, { data: { refreshToken: body.refreshToken } })
    expect(refreshed.ok()).toBeTruthy()
    auth = (await refreshed.json()).accessToken as string
  })

  function seedPage(page: import('@playwright/test').Page) {
    page.addInitScript((t) => localStorage.setItem('xihe-token', t), auth)
    page.addInitScript(
      (raw) => localStorage.setItem('xihe-user', raw),
      JSON.stringify({ id: 'e2e-user', email: 'plan0384-mxcoff@test.com', name: 'MxcOff', workspaceId: seedWs }),
    )
    page.addInitScript((ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)), { id: seedWs, name: 'MxcOff Seed' })
    page.addInitScript((id) => localStorage.setItem('xihe-workspace-id', id), seedWs)
  }

  test('real preflight reports MXC unavailable with a reason', async ({ request }) => {
    const res = await request.post(`${CP_URL}/api/v1/workspaces/capabilities/preflight`, {
      headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      data: { storageMode: 'direct_attach', hostPath: targetDir, executionMode: 'windows-mxc' },
    })
    expect(res.ok(), `preflight failed: ${res.status()} ${await res.text()}`).toBeTruthy()
    const body = await res.json()
    expect(body.available, JSON.stringify(body)).toBe(false)
    expect(String(body.reason ?? '')).not.toHaveLength(0)
    expect(String(body.reason)).toMatch(/SANDBOX_PROBE_FAILED|MXC|EXECUTABLE|UNAVAILABLE|not found/i)
  })

  test('UI disables MXC, never auto-switches, and creates only after an explicit host choice', async ({ page }) => {
    seedPage(page)
    await page.goto(`/workspace/${seedWs}`)
    await page.locator('[data-testid="workspace-toolbar-add"]').click()
    await expect(page.locator('[data-testid="workspace-create-dialog"]')).toBeVisible()

    await page.locator('[data-testid="workspace-storage-direct"]').click()
    await page.locator('[data-testid="workspace-source-path"]').fill(targetDir)
    await page.locator('[data-testid="workspace-source-read"]').click()
    await page.locator('[data-testid="workspace-source-use"]').click()

    // V2/V4: the MXC card is disabled and carries the real reason; the switch guidance is shown.
    const mxcCard = page.locator('[data-testid="workspace-execution-mode-mxc"]')
    await expect(mxcCard).toBeDisabled({ timeout: 20000 })
    await expect(page.locator('[data-testid="workspace-execution-mxc-status"]')).toContainText(/不可用/)
    await expect(page.locator('[data-testid="workspace-mxc-guidance"]')).toBeVisible()
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'mxc-unavailable-cards.png'), fullPage: true })

    // No automatic fallback: with the unavailable MXC still selected the flow cannot advance.
    await expect(page.locator('[data-testid="workspace-execution-next"]')).toBeDisabled()

    // Explicit switch to the unrestricted host backend, then confirm.
    await page.locator('[data-testid="workspace-switch-to-host"]').click()
    await expect(page.locator('[data-testid="workspace-execution-mode-host"]')).toHaveAttribute('aria-pressed', 'true')
    await page.locator('[data-testid="workspace-execution-next"]').click()
    await page.locator('[data-testid="workspace-create-name"]').fill(`Plan0384 MxcOff ${Date.now()}`)
    await page.locator('[data-testid="workspace-host-risk-ack"]').click()
    const createRequest = page.waitForRequest(
      (req) => req.url().endsWith('/api/v1/workspaces') && req.method() === 'POST',
    )
    await page.locator('[data-testid="workspace-create-submit"]').click()
    const request = await createRequest
    const payload = request.postDataJSON() as Record<string, unknown>
    expect(payload.executionMode).toBe('windows-host')
    expect(payload.hostPath).toBe(targetDir)
    await expect(page.locator('[data-testid="workspace-create-dialog"]')).toBeHidden({ timeout: 20000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'host-fallback-created.png'), fullPage: true })
  })
})
