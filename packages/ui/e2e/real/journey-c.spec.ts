import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
// e2e-host passes XIHE_WORKSPACE_HOST_ROOT to the runtime process but not to
// the Playwright process; the playwright env does carry XIHE_E2E_RUN_ID, and
// the runner's root is always <project>/.tmp/e2e-host/<run-id> (e2e-host.mjs:48).
const HOST_ROOT =
  process.env.XIHE_WORKSPACE_HOST_ROOT ??
  (process.env.XIHE_E2E_RUN_ID
    ? path.resolve(process.cwd(), '../../.tmp/e2e-host', process.env.XIHE_E2E_RUN_ID)
    : path.resolve(process.cwd(), '../../.xihe-workspaces'))
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? 'mock'
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../.local/evidence/journey-c')

// PLAN-292 Journey C spec: post-290 debts with hard Host evidence.
//   T6  — image preview via binary-safe read_file_range (no LLM needed)
//   H2  — >500-char write_file approval lands via argumentsHash matching
//   C1-C3 — refresh mid-approval recovers banner + modal; decide still works
// H2/C tests need the deterministic fake LLM marker mode:
//   XIHE_E2E_LLM_MODE=write_file mise run test:e2e-host -- e2e/real/journey-c.spec.ts
// They self-skip under other modes.
test.describe('@host Journey C — post-290 hash/preview/recovery', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  // PLAN-290 constraint: the Agent keeps ONE MCP workspace binding per process
  // — every test must share a single registered user/workspace (journey-a did
  // the same). Unique file names keep the runs independent.
  let sharedAuth: string
  let sharedWs: string
  let sharedHeaders: Record<string, string>

  test.beforeAll(async ({ request }) => {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `journey-c-${Date.now()}@test.com`, password, name: 'JourneyC' },
    })
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(reg.status())
    const auth = await reg.json()
    sharedAuth = auth.accessToken
    sharedWs = auth.workspaceId
    sharedHeaders = { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' }
  })

  function seedPage(page: import('@playwright/test').Page, token: string, wsId: string) {
    page.addInitScript((t) => localStorage.setItem('xihe-token', t), token)
    page.addInitScript((raw) => localStorage.setItem('xihe-user', raw), JSON.stringify({ workspaceId: wsId }))
    page.addInitScript((ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)), { id: wsId, name: 'Default Workspace' })
  }

  // 新建对话 switches sessions asynchronously and clears the input — fill with
  // a retry until the send button reflects the non-empty input.
  async function sendChat(page: import('@playwright/test').Page, text: string) {
    const input = page.locator('[data-testid="chat-input"]')
    const send = page.locator('[data-testid="chat-send-button"]')
    for (let i = 0; i < 6; i++) {
      await input.fill(text)
      if (await send.isEnabled().catch(() => false)) break
      await page.waitForTimeout(1000)
    }
    await expect(send).toBeEnabled({ timeout: 15000 })
    await send.click()
  }

  test('T6: opening a raster image renders the ImagePreview via binary-safe read', async ({ page }) => {
    const authToken = sharedAuth
    const wsId = sharedWs
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    // 1x1 transparent PNG — a real binary that read_to_string cannot carry.
    // Seed it through the CP upload API so the file lands in the workspace
    // registry (a raw host-dir write never shows up in the tree).
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    )
    const imageName = `journey-c-image-${Date.now()}.png`
    const up = await page.request.post(`${CP_URL}/api/v1/files/upload`, {
      // multipart boundary must set its own Content-Type — no JSON header here.
      headers: { Authorization: `Bearer ${authToken}`, 'X-Workspace-Id': wsId },
      multipart: { file: { name: imageName, mimeType: 'image/png', buffer: png } },
    })
    expect([200, 201], `upload failed: ${up.status()} ${await up.text()}`).toContain(up.status())

    seedPage(page, authToken, wsId)
    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    // The tree renders via the reka-ui Tree primitive (ARIA tree/treeitem),
    // not the legacy FileTreeNode div — select by role.
    const node = page.getByRole('treeitem', { name: imageName })
    await expect(node, 'image file appears in the tree').toBeVisible({ timeout: 30000 })
    await node.click()

    const preview = page.locator('[data-testid="workspace-image-preview"]')
    await expect(preview, 'ImagePreview branch reachable via base64 read').toBeVisible({ timeout: 30000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 't6-image-preview.png'), fullPage: false })
  })

  test('H2: >500-char write_file approves and lands the FULL content (argumentsHash)', async ({ page, request }) => {
    test.skip(LLM_MODE !== 'write_file', 'requires XIHE_E2E_LLM_MODE=write_file fake LLM marker mode')
    const authToken = sharedAuth
    const wsId = sharedWs
    const headers = sharedHeaders
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const hostDir = path.join(HOST_ROOT, wsId)
    const fileName = `journey-c-big-${Date.now()}.md`
    // >500 chars single line: forces the approval preview truncation that used
    // to 409 after approval (PLAN-290 §7 grant-vs-preview debt).
    const content = Array.from({ length: 30 }, (_, i) => `XIHE grant hash probe line ${i} with deterministic padding 0123456789.`).join(' ')
    expect(content.length).toBeGreaterThan(500)

    seedPage(page, authToken, wsId)
    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    const chatInput = page.locator('[data-testid="chat-input"]')
    await expect(chatInput).toBeVisible({ timeout: 20000 })
    const modal = page.locator('[data-testid="modal-content"]')

    await chatInput.fill(`XIHE-E2E-WRITE ${fileName} ${content}`)
    await page.locator('[data-testid="chat-send-button"]').click()
    await expect(modal, 'approval modal for large write_file').toBeVisible({ timeout: 120000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'h2-modal-truncated.png'), fullPage: false })
    await modal.locator('[data-testid="approval-approve"]').click()
    await expect(modal).toBeHidden({ timeout: 20000 })

    const approvedPath = path.join(hostDir, fileName)
    await expect
      .poll(async () => {
        try {
          return readFileSync(approvedPath, 'utf8')
        } catch {
          return ''
        }
      }, { message: `expected ${approvedPath} to contain the full content`, timeout: 30000 })
      .toContain(content)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'h2-after-approve.png'), fullPage: false })

    const opsRes = await request.get(`${CP_URL}/api/v1/operations?size=20`, { headers })
    expect(opsRes.ok(), `operations list ${opsRes.status()}`).toBeTruthy()
    const ops = (await opsRes.json()) as { operations: Array<{ id: string }> }
    expect(ops.operations.length).toBeGreaterThan(0)
    const traceRes = await request.get(`${CP_URL}/api/v1/operations/${ops.operations[0].id}`, { headers })
    const trace = (await traceRes.json()) as { items?: Array<{ toolName?: string }> }
    expect((trace.items ?? []).map((i) => i.toolName)).toContain('write_file')
  })

  test('C1-C3: refresh mid-approval recovers banner + modal; decide still lands', async ({ page, request }) => {
    test.skip(LLM_MODE !== 'write_file', 'requires XIHE_E2E_LLM_MODE=write_file fake LLM marker mode')
    const authToken = sharedAuth
    const wsId = sharedWs
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const hostDir = path.join(HOST_ROOT, wsId)
    const fileName = `journey-c-recover-${Date.now()}.md`
    const content = 'recovered after refresh'

    seedPage(page, authToken, wsId)
    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    const chatInput = page.locator('[data-testid="chat-input"]')
    await expect(chatInput).toBeVisible({ timeout: 20000 })
    const modal = page.locator('[data-testid="modal-content"]')

    // Wait for the previous test's run to fully finish server-side — its
    // LangGraph teardown races the next send with CHAT_IN_PROGRESS (409).
    await expect.poll(async () => {
      const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers })
      const body = (await res.json()) as { operations?: Array<{ status?: string }> }
      return body.operations?.[0]?.status ?? 'unknown'
    }, { timeout: 120000, intervals: [2_000] }).toBe('completed')
    await sendChat(page, `XIHE-E2E-WRITE ${fileName} ${content}`)
    await expect(modal, 'approval modal before refresh').toBeVisible({ timeout: 120000 })

    // C1: hard refresh kills the SSE — server run stays awaiting_approval.
    await page.reload({ waitUntil: 'load' })
    const banner = page.locator('[data-testid="run-recovery-banner"]')
    await expect(banner, 'recovery banner appears after refresh').toBeVisible({ timeout: 60000 })
    await expect(banner).toContainText('会话已恢复')
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'c1-recovery-banner.png'), fullPage: false })

    // C2/C3: the pending approval is re-renderable and the decision lands.
    await expect(modal, 'pending approval re-rendered after refresh').toBeVisible({ timeout: 60000 })
    await modal.locator('[data-testid="approval-approve"]').click()
    await expect(modal).toBeHidden({ timeout: 20000 })
    await expect
      .poll(async () => {
        try {
          return readFileSync(path.join(hostDir, fileName), 'utf8')
        } catch {
          return ''
        }
      }, { message: 'post-recovery approve must land the file', timeout: 30000 })
      .toContain(content)

    // C3: dismiss the banner.
    await page.locator('[data-testid="run-recovery-dismiss"]').click()
    await expect(banner).toBeHidden()
  })

  test('C2-reject: recovered approval can be rejected with a terminal outcome', async ({ page, request }) => {
    test.skip(LLM_MODE !== 'write_file', 'requires XIHE_E2E_LLM_MODE=write_file fake LLM marker mode')
    const authToken = sharedAuth
    const wsId = sharedWs
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const hostDir = path.join(HOST_ROOT, wsId)
    const fileName = `journey-c-reject-${Date.now()}.md`

    seedPage(page, authToken, wsId)
    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    const chatInput = page.locator('[data-testid="chat-input"]')
    await expect(chatInput).toBeVisible({ timeout: 20000 })
    const modal = page.locator('[data-testid="modal-content"]')

    await expect.poll(async () => {
      const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers })
      const body = (await res.json()) as { operations?: Array<{ status?: string }> }
      return body.operations?.[0]?.status ?? 'unknown'
    }, { timeout: 120000, intervals: [2_000] }).toBe('completed')
    await sendChat(page, `XIHE-E2E-WRITE ${fileName} should never be written`)
    await page.locator('[data-testid="chat-send-button"]').click()
    await expect(modal).toBeVisible({ timeout: 120000 })
    await page.reload({ waitUntil: 'load' })
    await expect(page.locator('[data-testid="run-recovery-banner"]')).toBeVisible({ timeout: 60000 })
    await expect(modal, 'approval modal re-rendered after refresh').toBeVisible({ timeout: 60000 })
    await modal.locator('[data-testid="approval-reject"]').click()
    await expect(modal).toBeHidden({ timeout: 20000 })
    await expect(page.locator('text=APPROVAL_REJECTED').first(), 'terminal APPROVAL_REJECTED visible').toBeVisible({
      timeout: 60000,
    })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'c2-after-reject.png'), fullPage: false })
    expect(existsSync(path.join(hostDir, fileName)), 'rejected write must not create host file').toBe(false)
  })
})
