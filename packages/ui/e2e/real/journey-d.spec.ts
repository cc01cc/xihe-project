import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { generateE2EPassword } from './helpers/password'
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? 'mock'
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../.local/evidence/journey-d')

// PLAN-294 Journey D spec: context pipeline + auto-compaction.
//   D1 — multi-turn memory: turn-2 LLM response must reference turn-1's marker
//   (M2/M3 tests will extend this spec with compaction assertions.)
// D1 needs the deterministic fake LLM marker mode:
//   XIHE_E2E_LLM_MODE=history-marker mise run test:e2e-host -- e2e/real/journey-d.spec.ts
// The fake LLM scans the full messages array it receives and echoes:
//   XIHE-HIST-SEEN: <prior markers> | XIHE-HIST-CURRENT: <current marker>
// M0 intentionally pins the CURRENT broken behavior: turn-2 sees no history,
// so D1 FAILS with "no prior markers" until M1 wires the pipeline.
test.describe('@host Journey D — context pipeline', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  // Agent keeps ONE MCP workspace binding per process — share a single
  // registered user/workspace across the describe (journey-a/b/c pattern).
  let sharedAuth: string
  let sharedWs: string
  let sharedHeaders: Record<string, string>

  test.beforeAll(async ({ request }) => {
    const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
    const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `journey-d-${Date.now()}@test.com`, password, name: 'JourneyD' },
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
    // The click can race the SSE component hydration: a click before
    // streamComponent mounts returns null from sendMessage and never POSTs.
    // Retry until the optimistic user bubble appears (send clears the input).
    for (let i = 0; i < 10; i++) {
      await send.click()
      try {
        await expect(
          page.locator('[data-slot="message"][data-align="end"]').first(),
        ).toBeVisible({ timeout: 3000 })
        return
      } catch {
        await page.waitForTimeout(1000)
      }
    }
    throw new Error('send never produced a user message bubble')
  }

  // Wait until the latest operation reaches a terminal state — the next send
  // would otherwise race the previous run teardown with CHAT_IN_PROGRESS (409).
  async function awaitLastOperationCompleted(request: import('@playwright/test').APIRequestContext) {
    await expect.poll(async () => {
      const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers: sharedHeaders })
      const body = (await res.json()) as { operations?: Array<{ status?: string }> }
      return body.operations?.[0]?.status ?? 'unknown'
    }, { timeout: 120000, intervals: [2_000] }).toBe('completed')
  }

  test('D1: turn-2 LLM sees turn-1 marker (multi-turn memory reaches the provider)', async ({ page }) => {
    test.skip(LLM_MODE !== 'history-marker', 'requires XIHE_E2E_LLM_MODE=history-marker fake LLM marker mode')
    const authToken = sharedAuth
    const wsId = sharedWs
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const marker1 = `T1${Date.now().toString(36).toUpperCase()}`
    const marker2 = `T2${Date.now().toString(36).toUpperCase()}`

    seedPage(page, authToken, wsId)
    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    const chatInput = page.locator('[data-testid="chat-input"]')
    await expect(chatInput, 'chat input visible on workspace page').toBeVisible({ timeout: 20000 })
    const lastAssistant = page
      .locator('[data-slot="message"][data-align="start"]')
      .last()

    // Turn 1: plant the marker. The reply echoes XIHE-HIST-SEEN: none (first
    // turn — no history yet, this half holds both before and after M1).
    await sendChat(page, `Remember marker XIHE-E2E-HIST ${marker1} for later.`)
    await expect(
      lastAssistant,
      'turn-1 reply echoes the fake LLM marker envelope',
    ).toContainText('XIHE-HIST-SEEN: none', { timeout: 120000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'd1-turn1.png'), fullPage: false })

    await awaitLastOperationCompleted(page.request)

    // Turn 2: plant a second marker. The provider receives the messages array
    // — if the pipeline is intact, turn-1's marker MUST be among them.
    await sendChat(page, `Now check: marker XIHE-E2E-HIST ${marker2}. What markers do you see?`)
    const reply = lastAssistant
    await expect(
      reply,
      'turn-2 reply echoes the fake LLM marker envelope',
    ).toContainText(`XIHE-HIST-CURRENT: ${marker2}`, { timeout: 120000 })

    // THE PIN: turn-1's marker must appear in the provider-visible history.
    await expect(
      reply,
      'turn-2 request must carry turn-1 marker (conversation memory)',
    ).toContainText(`XIHE-HIST-SEEN: ${marker1}`, { timeout: 30000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'd1-turn2-memory.png'), fullPage: false })
  })
})
