import { mkdirSync } from 'node:fs'
import path from 'node:path'
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
const EVIDENCE_DIR = evidenceDir('journey-d')

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
    const ctx = await registerJourneyUser(request, 'journey-d')
    sharedAuth = ctx.authToken
    sharedWs = ctx.workspaceId
    sharedHeaders = ctx.headers
  })

  test('D1: turn-2 LLM sees turn-1 marker (multi-turn memory reaches the provider)', async ({ page }) => {
    test.skip(LLM_MODE !== 'history-marker', 'requires XIHE_E2E_LLM_MODE=history-marker fake LLM marker mode')
    // The fake-marker envelope assertions only hold against the fixture; a
    // real-provider smoke run (D1-real) must not execute them.
    test.skip(!!process.env.XIHE_E2E_REAL_XIAOMI_KEY, 'fixture marker envelope is fixture-only; real runs use D1-real')
    const authToken = sharedAuth
    const wsId = sharedWs
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const marker1 = `T1${Date.now().toString(36).toUpperCase()}`
    const marker2 = `T2${Date.now().toString(36).toUpperCase()}`

    seedPage(page, { authToken, workspaceId: wsId, headers: sharedHeaders })
    // A brand-new user may land on the empty "no active session" state —
    // 新建对话 is the real user path out of it (auto-session creation can
    // race CP readiness on cold starts).
    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    const chatInput = page.locator('[data-testid="chat-input"]')
    if (!(await chatInput.isVisible({ timeout: 10000 }).catch(() => false))) {
      const newChat = page.getByRole('button', { name: '新建对话' }).first()
      if (await newChat.isVisible().catch(() => false)) {
        await newChat.click()
      } else {
        await page.reload({ waitUntil: 'load' })
      }
    }
    await expect(chatInput, 'chat input visible on workspace page').toBeVisible({ timeout: 30000 })
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

    await awaitLastOperationCompleted(page.request, sharedHeaders)

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

  test('D1-real: multi-turn memory with the real model (smoke)', async ({ page }) => {
    test.skip(!process.env.XIHE_E2E_REAL_XIAOMI_KEY, 'requires a real provider key (XIHE_E2E_REAL_XIAOMI_KEY)')
    const authToken = sharedAuth
    const wsId = sharedWs
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const codeWord = `XH${Date.now().toString(36).toUpperCase()}`

    seedPage(page, { authToken, workspaceId: wsId, headers: sharedHeaders })
    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    await ensureChatReady(page)
    const lastAssistant = page
      .locator('[data-slot="message"][data-align="start"]')
      .last()

    // Turn 1: teach a nonsense codeword.
    await sendChat(page, `请记住一个暗号：${codeWord}。只回复“已记住”。`)
    await awaitLastOperationCompleted(page.request)

    // Turn 2: ask for it back. With the M1 pipeline wired, the model must
    // recall the codeword from the projection snapshot history.
    await sendChat(page, `我刚才告诉你的暗号是什么？只回复暗号本身。`)
    await expect(
      lastAssistant,
      'real-model turn-2 must recall turn-1 codeword via snapshot history',
    ).toContainText(codeWord, { timeout: 120000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'd1-real-memory.png'), fullPage: false })
  })

  test('D2: manual compaction keeps summary visible to the LLM (epoch injection)', async ({ page }) => {
    test.skip(LLM_MODE !== 'history-marker', 'requires XIHE_E2E_LLM_MODE=history-marker fake LLM marker mode')
    const authToken = sharedAuth
    const wsId = sharedWs
    const headers = sharedHeaders
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    const markerA = `A${Date.now().toString(36).toUpperCase()}`
    const markerB = `B${Date.now().toString(36).toUpperCase()}`

    seedPage(page, { authToken, workspaceId: wsId, headers: sharedHeaders })
    await page.goto('/workspace/' + wsId, { waitUntil: 'load' })
    const lastAssistant = page
      .locator('[data-slot="message"][data-align="start"]')
      .last()

    // Turn 1: plant marker A, wait for the run to finish server-side.
    await sendChat(page, `Plant marker XIHE-E2E-HIST ${markerA} now.`)
    await expect(lastAssistant).toContainText(`XIHE-HIST-CURRENT: ${markerA}`, { timeout: 120000 })
    await awaitLastOperationCompleted(page.request, sharedHeaders)

    // Manual compaction (decision #15): user-reachable endpoint on
    // /api/v1/sessions (M3 UI entry will call the same route).
    const sessRes = await page.request.get(`${CP_URL}/api/v1/sessions`, { headers })
    expect(sessRes.ok(), `sessions list ${sessRes.status()}`).toBeTruthy()
    const body = (await sessRes.json()) as { sessions?: Array<{ id: string }> }
    const sessionId = body.sessions?.[0]?.id ?? ''
    expect(sessionId, 'session id resolvable').not.toBe('')
    const comp2 = await page.request.post(
      `${CP_URL}/api/v1/sessions/${sessionId}/compact`,
      { headers, data: {} },
    )
    expect(comp2.ok(), `compact must succeed: ${comp2.status()} ${await comp2.text()}`).toBeTruthy()

    // Turn 2: the pre-compaction marker must STILL reach the provider —
    // via the summary (epoch) and/or the kept-recent tail rather than raw
    // full history.
    await sendChat(page, `Now plant marker XIHE-E2E-HIST ${markerB}. What markers exist?`)
    const reply = lastAssistant
    await expect(reply).toContainText(`XIHE-HIST-CURRENT: ${markerB}`, { timeout: 120000 })
    await expect(
      reply,
      'post-compaction turn must still see pre-compaction marker (summary + kept tail)',
    ).toContainText(markerA, { timeout: 30000 })
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'd2-post-compaction-memory.png'), fullPage: false })
  })
})
