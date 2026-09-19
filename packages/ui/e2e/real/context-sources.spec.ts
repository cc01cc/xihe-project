import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  CP_URL,
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
  let sharedHeaders: Record<string, string>

  test.beforeAll(async ({ request }) => {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const ctx = await registerJourneyUser(request, 'plan-0340')
    sharedAuth = ctx.authToken
    sharedWs = ctx.workspaceId
    sharedHeaders = ctx.headers
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

  test('U1 metadata visible; U2 toast on AGENTS create/change; sources GET has no body', async ({
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

    // U2 toast from first-run created status (or later change).
    const toast = page.locator('[data-sonner-toast], [role="status"]')
    await expect(
      toast.filter({ hasText: /规则已更新|Rules updated/ }).first(),
      'U2 source-update toast visible after first refresh',
    ).toBeVisible({ timeout: 30000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u2-toast-first.png'), fullPage: false })

    await toggle.click()
    const body = page.locator('[data-testid="u1-body"]')
    await expect(body).toBeVisible()
    await expect(body).toContainText('AGENTS.md')
    const bodyText = (await body.innerText()) || ''
    expect(bodyText, 'U1 must not leak rules body').not.toContain('Be concise.')
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u1-expanded.png'), fullPage: false })

    // Discover sessionId via sessions API (store keys vary).
    const sessionsRes = await request.get(`${CP_URL}/api/v1/sessions`, { headers: sharedHeaders })
    let sessionId = ''
    if (sessionsRes.ok()) {
      const sessionsBody = (await sessionsRes.json()) as {
        sessions?: Array<{ id?: string; sessionId?: string }>
      }
      sessionId = sessionsBody.sessions?.[0]?.id ?? sessionsBody.sessions?.[0]?.sessionId ?? ''
    }
    expect(sessionId, 'at least one session exists').toBeTruthy()
    const src = await request.get(`${CP_URL}/api/v1/context/${sessionId}/sources`, {
      headers: sharedHeaders,
    })
    expect(src.ok(), `sources GET ${src.status()} ${await src.text()}`).toBeTruthy()
    const payload = (await src.json()) as Record<string, unknown>
    expect(payload.sourceKey).toBe('AGENTS.md')
    expect(JSON.stringify(payload)).not.toContain('Be concise.')
    if (typeof payload.hashPrefix === 'string' && payload.hashPrefix) {
      expect(payload.hashPrefix.length).toBeLessThanOrEqual(8)
    }

    // Second AGENTS change → U2 again (refresh before Agent).
    await writeAgents(request, `# Workspace rules v2\nBe thorough after update.\n`)
    await sendChat(page, 'Second turn after AGENTS update for U2 toast.')
    await expect(
      toast.filter({ hasText: /规则已更新|Rules updated/ }).first(),
      'U2 toast after rules change',
    ).toBeVisible({ timeout: 30000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u2-toast-change.png'), fullPage: false })

    const style = await toggle.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { display: cs.display, fontSize: cs.fontSize, color: cs.color }
    })
    expect(style.display).not.toBe('none')
    expect(Number.parseFloat(style.fontSize)).toBeGreaterThan(0)
  })
})
