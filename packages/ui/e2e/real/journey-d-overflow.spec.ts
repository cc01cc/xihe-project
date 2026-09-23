import { mkdirSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import {
  CP_URL,
  awaitLastOperationCompleted,
  ensureChatReady,
  evidenceDir,
  registerJourneyUser,
  seedPage,
  sendChat,
} from './helpers/journey'

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? 'mock'
const EVIDENCE_DIR = evidenceDir('journey-d-overflow')

// PLAN-0341 V2 (T2.2): fake-llm mode=overflow refuses the first completion
// with context_length_exceeded until a compacted SUM system message is
// present; CP must compact + re-dispatch the same run once, then the retry
// succeeds with OVERFLOW-RETRY-OK. U3 toast is the user-visible marker.
test.describe('@host Journey D — overflow retry (CTX-1)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  let sharedAuth: string
  let sharedWs: string
  let sharedHeaders: Record<string, string>

  test.beforeAll(async ({ request }) => {
    const ctx = await registerJourneyUser(request, 'journey-ovf')
    sharedAuth = ctx.authToken
    sharedWs = ctx.workspaceId
    sharedHeaders = ctx.headers
  })

  test('V2: CONTEXT_OVERFLOW → compact → one retry succeeds', async ({ page }) => {
    test.skip(LLM_MODE !== 'overflow', 'requires XIHE_E2E_LLM_MODE=overflow fake LLM')

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    seedPage(page, {
      authToken: sharedAuth,
      workspaceId: sharedWs,
      headers: sharedHeaders,
    })

    // Chat route uses toolMode=none (WorkspaceView hardcodes workspace tools,
    // which fails on --skip-runtime when MCP cannot bind another workspace).
    await page.goto('/workspace', { waitUntil: 'load' })
    await ensureChatReady(page)
    await sendChat(page, 'XIHE-E2E-OVERFLOW please answer after context shrink')
    await awaitLastOperationCompleted(page.request, sharedHeaders)

    // Official reply is the retry payload (decision #2 ③).
    const assistant = page
      .locator('[data-slot="message"]')
      .filter({ hasText: 'OVERFLOW-RETRY-OK' })
      .first()
    await expect(assistant).toBeVisible({ timeout: 30000 })

    // U3 toast marker (PLAN-0340/spec/ui-surfaces.md) + V9 computed style.
    const overflowToast = page.getByText(/上下文超限|Context limit exceeded/)
    const toastEl = overflowToast.first()
    await expect(toastEl).toBeVisible({ timeout: 15000 })
    const toastBox = await toastEl.boundingBox()
    expect(toastBox, 'U3 toast layout box').toBeTruthy()
    const toastStyle = await toastEl.evaluate((el) => {
      const cs = window.getComputedStyle(el)
      return { opacity: cs.opacity, visibility: cs.visibility, fontSize: cs.fontSize }
    })
    expect(toastStyle.visibility).not.toBe('hidden')
    expect(Number(toastStyle.opacity)).toBeGreaterThan(0)
    expect(Number.parseFloat(toastStyle.fontSize)).toBeGreaterThan(8)

    // Public session messages must persist the retry reply.
    const sessions = await page.request.get(`${CP_URL}/api/v1/sessions`, { headers: sharedHeaders })
    const sessionsBody = (await sessions.json()) as { sessions?: Array<{ id: string }> }
    const sessionId = sessionsBody.sessions?.[0]?.id
    expect(sessionId, 'session list has an id').toBeTruthy()
    const messagesRes = await page.request.get(
      `${CP_URL}/api/v1/sessions/${sessionId}/messages`,
      { headers: sharedHeaders },
    )
    expect(messagesRes.ok(), `messages fetch status=${messagesRes.status()}`).toBe(true)
    const messagesBody = await messagesRes.text()
    expect(messagesBody, 'persisted assistant reply is the overflow retry payload').toContain('OVERFLOW-RETRY-OK')

    await page.screenshot({ path: `${EVIDENCE_DIR}/u3-overflow-retry.png`, fullPage: true })
  })
})
