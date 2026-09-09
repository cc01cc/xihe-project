import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const HOST_ROOT =
  process.env.XIHE_WORKSPACE_HOST_ROOT ??
  path.resolve(process.cwd(), '../../.xihe-workspaces')

// Agent keeps one MCP workspace binding per process (PLAN-262). Approve → reject
// must share one registered user/workspace; do not parallelize with another
// workspace chat on the same Agent.
test.describe('@host Journey A — AI write_file approve/reject', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  test('A1/A2/A3: create file via write_file — approve lands FS; reject leaves FS unchanged', async ({
    page,
    request,
  }) => {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: {
        email: `journey-a-${Date.now()}@test.com`,
        password,
        name: 'JourneyA',
      },
    })
    expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(
      reg.status(),
    )
    const auth = await reg.json()
    const authToken: string = auth.accessToken
    const wsId: string = auth.workspaceId
    const authHeaders = { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }

    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
    await page.addInitScript(
      (raw) => localStorage.setItem('xihe-user', raw),
      JSON.stringify({ workspaceId: wsId }),
    )
    await page.addInitScript(
      (ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)),
      { id: wsId, name: 'Default Workspace' },
    )

    const hostDir = path.join(HOST_ROOT, wsId)
    const approveFile = `journey-a-approve-${Date.now()}.md`
    const approveContent = '# Journey A Approve'
    const rejectFile = `journey-a-reject-${Date.now()}.md`

    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    const chatInput = page.locator('[data-testid="chat-input"]')
    await expect(chatInput).toBeVisible({ timeout: 20000 })
    const modal = page.locator('[data-testid="modal-content"]')

    // --- A1+A2: approve write_file → FS change ---
    await chatInput.fill(
      `请在工作区根目录创建文件 ${approveFile}，内容只写一行「${approveContent}」，然后简短确认。`,
    )
    await page.locator('[data-testid="chat-send-button"]').click()
    await expect(modal, 'approval modal for write_file').toBeVisible({ timeout: 120000 })
    // Path preview should appear; avoid asserting secret material.
    await expect(modal).toContainText(approveFile, { timeout: 10000 })
    await page.screenshot({ path: 'journey-a-approve-modal.png', fullPage: false })
    await modal.locator('[data-testid="approval-approve"]').click()
    await expect(modal).toBeHidden({ timeout: 20000 })

    // FS readback (A2 hard assert) — path normalization: workspace-relative file
    const approvedPath = path.join(hostDir, approveFile)
    await expect
      .poll(
        async () => {
          try {
            return readFileSync(approvedPath, 'utf8')
          } catch {
            return ''
          }
        },
        {
          message: `expected ${approvedPath} to contain approve content`,
          timeout: 20000,
        },
      )
      .toContain(approveContent)
    await page.screenshot({ path: 'journey-a-after-approve.png', fullPage: false })

    // A5: user-facing ledger shows write_file tool item
    const opsRes = await request.get(`${CP_URL}/api/v1/operations?size=20`, {
      headers: authHeaders,
    })
    expect(opsRes.ok(), `operations list ${opsRes.status()}`).toBeTruthy()
    const ops = (await opsRes.json()) as { operations: Array<{ id: string; actorType?: string }> }
    expect(ops.operations.length).toBeGreaterThan(0)
    const traceRes = await request.get(`${CP_URL}/api/v1/operations/${ops.operations[0].id}`, {
      headers: authHeaders,
    })
    expect(traceRes.ok(), `trace ${traceRes.status()}`).toBeTruthy()
    const trace = (await traceRes.json()) as {
      items?: Array<{ toolName?: string; policyDecision?: string }>
    }
    const toolNames = (trace.items ?? []).map((i) => i.toolName)
    expect(
      toolNames,
      `expected write_file in trace, got ${JSON.stringify(toolNames)}`,
    ).toContain('write_file')

    // Settle: first write_file may still be finishing LangGraph after FS write
    // (grant response / tool_result). Avoid CHAT_IN_PROGRESS on next send.
    await page.waitForTimeout(5000)

    // --- A3: reject write_file → APPROVAL_REJECTED; no new file ---
    await expect(chatInput).toBeVisible({ timeout: 20000 })
    await chatInput.fill(
      `请在工作区根目录创建文件 ${rejectFile}，内容写一行 # should not exist，然后简短确认。`,
    )
    await page.locator('[data-testid="chat-send-button"]').click()
    await expect(modal, 'approval modal for reject case').toBeVisible({ timeout: 120000 })
    await modal.locator('[data-testid="approval-reject"]').click()
    await expect(modal).toBeHidden({ timeout: 20000 })
    await expect(
      page.locator('text=APPROVAL_REJECTED').first(),
      'terminal APPROVAL_REJECTED visible',
    ).toBeVisible({ timeout: 60000 })
    await page.screenshot({ path: 'journey-a-after-reject.png', fullPage: false })

    expect(
      existsSync(path.join(hostDir, rejectFile)),
      'rejected write must not create host file',
    ).toBe(false)

    // Ledger / messages: user message persisted; run should not hang forever
    const sessionsRes = await request.get(`${CP_URL}/api/v1/sessions`, { headers: authHeaders })
    expect(sessionsRes.ok()).toBeTruthy()
    const sessions = (await sessionsRes.json()) as { sessions: Array<{ id: string }> }
    expect(sessions.sessions.length).toBeGreaterThan(0)
    const sid = sessions.sessions[0].id
    const messagesRes = await request.get(`${CP_URL}/api/v1/sessions/${sid}/messages`, {
      headers: authHeaders,
    })
    expect(messagesRes.ok()).toBeTruthy()
    const messages = (await messagesRes.json()) as Array<{ role: string }>
    const roles = messages.map((m) => m.role.toUpperCase())
    expect(roles).toContain('USER')
  })

  test('A4 optional: expire when XIHE_APPROVAL_TIMEOUT_SECONDS is short', async ({
    page,
    request,
  }) => {
    test.skip(
      process.env.XIHE_E2E_APPROVAL_EXPIRE !== '1',
      'set XIHE_E2E_APPROVAL_EXPIRE=1 with Agent XIHE_APPROVAL_TIMEOUT_SECONDS≈5 for expire case',
    )

    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: {
        email: `journey-a-exp-${Date.now()}@test.com`,
        password,
        name: 'JourneyAExp',
      },
    })
    expect([200, 201]).toContain(reg.status())
    const auth = await reg.json()
    const wsId: string = auth.workspaceId

    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), auth.accessToken)
    await page.addInitScript(
      (raw) => localStorage.setItem('xihe-user', raw),
      JSON.stringify({ workspaceId: wsId }),
    )
    await page.addInitScript(
      (ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)),
      { id: wsId, name: 'Default Workspace' },
    )

    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    const textarea = page.locator('textarea')
    await expect(textarea).toBeVisible({ timeout: 20000 })
    const modal = page.locator('[data-testid="modal-content"]')
    const expFile = `journey-a-exp-${Date.now()}.md`

    await textarea.fill(`请创建文件 ${expFile} 内容 # exp，然后确认。`)
    await textarea.press('Enter')
    await expect(modal).toBeVisible({ timeout: 90000 })
    // Do not click; wait past agent TTL (env should be ~5s)
    await page.waitForTimeout(8000)
    await page.reload({ waitUntil: 'load' })
    await expect(textarea).toBeVisible({ timeout: 20000 })
    await page.waitForTimeout(2000)
    // No ghost pending modal after expire + reload
    await expect(modal).toBeHidden()
    await expect(existsSync(path.join(HOST_ROOT, wsId, expFile))).toBe(false)
  })
})
