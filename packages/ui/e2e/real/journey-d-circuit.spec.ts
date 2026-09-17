import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import {
  CP_URL,
  evidenceDir,
  registerJourneyUser,
  seedPage,
} from './helpers/journey'

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? 'mock'
const EVIDENCE_DIR = evidenceDir('journey-d-circuit')
const SERVICE_TOKEN = process.env.XIHE_CP_API_TOKEN ?? ''

// PLAN-0341 V3/V9 (U4): recovery-band circuit surfaces as a session toast.
// Seed a fat keep-recent via internal context events, public-compact, and
// assert the warn toast + toast computed style (low-disturbance banner).
test.describe('@host Journey D — compaction circuit (U4)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(180000)

  test('V3/U4: residual above recovery band opens circuit toast', async ({ page, request }) => {
    test.skip(LLM_MODE !== 'mock' && LLM_MODE !== 'overflow' && LLM_MODE !== 'history-marker',
      'circuit host case is chat-only; any fake LLM mode works')
    test.skip(!SERVICE_TOKEN, 'requires XIHE_CP_API_TOKEN (host e2e always provides it)')

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const ctx = await registerJourneyUser(request, 'journey-circuit')
    const create = await request.post(`${CP_URL}/api/v1/sessions`, {
      headers: ctx.headers,
      data: { title: 'circuit-host' },
    })
    expect([200, 201]).toContain(create.status())
    const created = (await create.json()) as { id?: string; session?: { id?: string } }
    const sessionId = created.id ?? created.session?.id
    expect(sessionId, 'session id').toBeTruthy()

    const serviceHeaders = {
      Authorization: `Bearer ${SERVICE_TOKEN}`,
      'Content-Type': 'application/json',
    }
    // session.created + fat human turns so post-compact residual stays huge.
    const fat = 'U4-RESIDUAL '.repeat(2500) // ~30k chars
    const seed = [
      {
        type: 'session.created',
        payload: {
          workspace_id: ctx.workspaceId,
          user_id: '',
          epoch_id: 'e-circuit',
          baseline_hash: 'h',
          system_messages: ['sys'],
        },
      },
      ...Array.from({ length: 20 }, (_, i) => ({
        type: 'prompt.admitted',
        payload: { message: { role: 'human', content: `${fat} turn=${i}` } },
      })),
    ]
    const batch = await request.post(
      `${CP_URL}/internal/v1/context/${sessionId}/events/batch`,
      { headers: serviceHeaders, data: seed },
    )
    expect(batch.ok(), `batch status=${batch.status()} ${await batch.text()}`).toBe(true)

    seedPage(page, { authToken: ctx.authToken, workspaceId: ctx.workspaceId, headers: ctx.headers })
    await page.goto(`/chat/${sessionId}`, { waitUntil: 'load' })

    // Public compact triggers applyRecoveryBand → SSE circuit open → U4 toast.
    const compact = await request.post(`${CP_URL}/api/v1/sessions/${sessionId}/compact`, {
      headers: ctx.headers,
      data: {},
    })
    expect(compact.ok(), `compact status=${compact.status()} ${await compact.text()}`).toBe(true)

    const circuitToast = page.getByText(/自动压缩已暂停|Auto-compaction paused/)
    await expect(circuitToast.first()).toBeVisible({ timeout: 20000 })

    const toastEl = circuitToast.first()
    const box = await toastEl.boundingBox()
    expect(box, 'circuit toast has layout box').toBeTruthy()
    expect(box!.width, 'toast not zero-width').toBeGreaterThan(10)
    const styles = await toastEl.evaluate((el) => {
      const cs = window.getComputedStyle(el)
      return {
        opacity: cs.opacity,
        visibility: cs.visibility,
        color: cs.color,
        fontSize: cs.fontSize,
        ariaLabel: el.getAttribute('aria-label'),
        role: el.getAttribute('role'),
        testId: el.getAttribute('data-testid'),
      }
    })
    expect(styles.visibility).not.toBe('hidden')
    expect(Number(styles.opacity)).toBeGreaterThan(0)

    // Durable fact: context.compaction_circuit state=open via internal events.
    const eventsRes = await request.get(
      `${CP_URL}/internal/v1/context/${sessionId}/events?afterSequence=0`,
      { headers: serviceHeaders },
    )
    if (eventsRes.ok()) {
      const body = await eventsRes.text()
      expect(body).toContain('context.compaction_circuit')
      expect(body).toContain('open')
    }

    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'u4-circuit-open.png'), fullPage: true })
  })
})
