import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  ensureAgentWorkspaceBinding,
  ensureChatReady,
  evidenceDir,
  registerJourneyUser,
  sendChat,
} from './helpers/journey'

const RUNTIME_URL = `http://localhost:${process.env.XIHE_RUNTIME_PORT || '12633'}`
const SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN ?? 'dev-token-not-secure'
const EVIDENCE_DIR = evidenceDir('plan-0340-context-sources')

/**
 * PLAN-0340 V14 — U1 source summary + U2 rules-updated toast (host browser).
 * Refresh runs before Agent dispatch, so U2 fires even if the stream fails.
 */
test.describe('@host PLAN-0340 U1/U2 context sources', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180000)

  let sharedAuth: string
  let sharedWs: string

  test.beforeAll(async ({ request }) => {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const ctx = await registerJourneyUser(request, 'plan-0340')
    sharedAuth = ctx.authToken
    sharedWs = ctx.workspaceId
  })

  async function writeAgents(
    request: import('@playwright/test').APIRequestContext,
    body: string,
  ): Promise<void> {
    const res = await request.post(
      `${RUNTIME_URL}/internal/v1/runtime/workspaces/${sharedWs}/files/write/AGENTS.md`,
      {
        headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
        data: Buffer.from(body, 'utf-8'),
      },
    )
    expect(res.ok(), `write AGENTS.md failed ${res.status()}`).toBeTruthy()
  }

  test('U1 metadata remains visible in one real host sample', async ({
    page,
    request,
  }) => {
    await writeAgents(request, `# Workspace rules\nBe concise.\n`)
    // PLAN-0369: rebind the Agent to this spec's workspace before the chat.
    await ensureAgentWorkspaceBinding(sharedWs)

    page.addInitScript((t) => localStorage.setItem('xihe-token', t), sharedAuth)
    page.addInitScript(
      (raw) => localStorage.setItem('xihe-user', raw),
      JSON.stringify({ workspaceId: sharedWs }),
    )
    page.addInitScript(
      (ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)),
      { id: sharedWs, name: 'Default Workspace' },
    )

    await page.goto('/workspace/' + sharedWs, { waitUntil: 'load' })
    await ensureChatReady(page)

    // First run: refresh runs before Agent dispatch → U2 toast for created AGENTS.
    await sendChat(page, 'Hello for plan-0340 context sources U1.')

    const toggle = page.locator('[data-testid="u1-toggle"]')
    await expect(toggle, 'U1 toggle visible').toBeVisible({ timeout: 15000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u1-toggle.png'), fullPage: false })

    await toggle.click()
    const body = page.locator('[data-testid="u1-body"]')
    await expect(body).toBeVisible()
    await expect(body).toContainText('AGENTS.md')
    const bodyText = (await body.innerText()) || ''
    expect(bodyText, 'U1 must not leak rules body').not.toContain('Be concise.')
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u1-expanded.png'), fullPage: false })

    const style = await toggle.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { display: cs.display, fontSize: cs.fontSize, color: cs.color }
    })
    expect(style.display).not.toBe('none')
    expect(Number.parseFloat(style.fontSize)).toBeGreaterThan(0)
  })
})
