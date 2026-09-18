import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? 'mock'
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../.local/evidence/job-resume')

// PLAN-0344 T1.4c：durable job 的真实 host 证据。
// 链路：workspace 会话发起 start_background_process（审批）→ 刷新后 job 卡片
// 从 messages DTO jobSummary 重建 → 按字节游标续看真实容器输出 → destroy
// workspace（档案落 orphaned）→ 续看显式 409 JOB_OUTPUT_LOST。
// 需要确定性 fake LLM 标记模式：
//   node scripts/e2e-host.mjs --retries=0 e2e/real/job-resume.spec.ts --llm-mode=job
test.describe('@host PLAN-0344 durable job resume', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  // PLAN-290 约束：Agent 每进程只绑定一个 workspace，测试共享同一注册用户/工作区。
  let sharedAuth: string
  let sharedWs: string
  let sharedHeaders: Record<string, string>

  test.beforeAll(async ({ request }) => {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `job-resume-${Date.now()}@test.com`, password, name: 'JobResume' },
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

  test('job card survives refresh, resumes output, and reports LOST after destroy', async ({ page }) => {
    test.skip(LLM_MODE !== 'job', 'requires XIHE_E2E_LLM_MODE=job fake LLM marker mode')
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    seedPage(page, sharedAuth, sharedWs)
    await page.goto('/workspace/' + sharedWs, { waitUntil: 'load' })

    const chatInput = page.locator('[data-testid="chat-input"]')
    await expect(chatInput).toBeVisible({ timeout: 20000 })
    const modal = page.locator('[data-testid="modal-content"]')

    await chatInput.fill('XIHE-E2E-JOB start the durable job')
    await page.locator('[data-testid="chat-send-button"]').click()

    // start_background_process 走审批门禁（REQUIRE_APPROVAL）
    await expect(modal, 'approval modal for start_background_process').toBeVisible({ timeout: 120000 })
    await modal.locator('[data-testid="approval-approve"]').click()
    await expect(modal).toBeHidden({ timeout: 20000 })

    // follow-up 流结束（run 收尾）后再刷新，避免半态
    await expect(page.getByText('Background job started.')).toBeVisible({ timeout: 60000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'job-started-live.png'), fullPage: false })

    // 刷新：卡片只能从 messages DTO 的 jobSummary 重建（tool_result 不持久化）
    await page.reload({ waitUntil: 'load' })
    const card = page
      .locator('[data-testid="tool-card-toggle"]')
      .filter({ hasText: 'start_background_process' })
      .first()
    await expect(card, 'job card restored from jobSummary after reload').toBeVisible({ timeout: 60000 })
    await card.click()

    const panel = page.locator('[data-testid="job-output-panel"]')
    await expect(panel).toBeVisible({ timeout: 20000 })
    await panel.locator('[data-testid="job-output-load"]').click()
    const output = panel.locator('[data-testid="job-output-data"]')
    await expect(output).toContainText('job-line-1', { timeout: 30000 })
    await expect(output).toContainText('job-line-2')
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'resume-after-reload.png'), fullPage: false })

    // 从账本取 job item id（destroy 后按 API 契约断言 409）
    const opsRes = await page.request.get(`${CP_URL}/api/v1/operations?size=5`, { headers: sharedHeaders })
    expect(opsRes.ok(), `operations list ${opsRes.status()}`).toBeTruthy()
    const ops = (await opsRes.json()) as { operations?: Array<{ id: string }> }
    let itemId = ''
    for (const op of ops.operations ?? []) {
      const traceRes = await page.request.get(`${CP_URL}/api/v1/operations/${op.id}`, { headers: sharedHeaders })
      if (!traceRes.ok()) continue
      const trace = (await traceRes.json()) as { items?: Array<{ id?: string; toolName?: string }> }
      const item = (trace.items ?? []).find((entry) => entry.toolName === 'start_background_process')
      if (item?.id) {
        itemId = item.id
        break
      }
    }
    expect(itemId, 'ledger item for the started job').toBeTruthy()

    // destroy workspace：Runtime destroying 窗口枚举存活 job → 档案落 orphaned
    const del = await page.request.delete(`${CP_URL}/api/v1/workspaces/${sharedWs}`, {
      headers: sharedHeaders,
    })
    expect([200, 202, 204], `destroy failed: ${del.status()} ${await del.text()}`).toContain(del.status())

    await expect
      .poll(
        async () => {
          const res = await page.request.get(`${CP_URL}/api/v1/operations/items/${itemId}/job-output`, {
            headers: sharedHeaders,
          })
          return res.status()
        },
        { timeout: 90000, message: 'job-output settles to 409 after destroy' },
      )
      .toBe(409)
    const lostBody = (await (
      await page.request.get(`${CP_URL}/api/v1/operations/items/${itemId}/job-output`, { headers: sharedHeaders })
    ).json()) as { code?: string }
    expect(lostBody.code, 'orphaned job reports LOST, not EXPIRED').toBe('JOB_OUTPUT_LOST')

    // UI 层显式提示（不刷新，保持 DOM 在场）
    await panel.locator('[data-testid="job-output-load"]').click()
    const error = panel.locator('[data-testid="job-output-error"]')
    await expect(error).toBeVisible({ timeout: 30000 })
    await expect(error).toContainText(/不可用|no longer available/)
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'destroy-lost.png'), fullPage: false })
    console.log(`[job-resume] evidence written to ${EVIDENCE_DIR}`)
  })
})
