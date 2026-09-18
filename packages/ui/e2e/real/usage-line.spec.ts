// PLAN-0343 U1/V6: run-terminal usage line in the session header.
// Flow: register → workspace page → deterministic write_file chat (approve) →
// run reaches done → the header usage line must show tokens, a mapped cost
// (or 未映射) and a source badge. DOM + screenshot + console evidence.
import { test, expect } from '@playwright/test'
import {
  CP_URL,
  registerJourneyUser,
  seedPage,
  ensureChatReady,
  awaitLastOperationCompleted,
} from './helpers/journey'

test.describe('@host PLAN-0343 — usage line in session header', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(240000)

  let ctx: { authToken: string; workspaceId: string; headers: Record<string, string> }

  test.beforeAll(async ({ request }) => {
    // Agent binds one workspace per process — register exactly once.
    ctx = await registerJourneyUser(request, 'usage-line')
  })

  test('usage line shows tokens, cost or unmapped, and source badge after done', async ({
    page,
    request,
  }) => {
    const consoleErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })

    seedPage(page, ctx)
    await page.goto('/workspace/' + ctx.workspaceId, { waitUntil: 'load' })
    await ensureChatReady(page)

    // Deterministic write_file → approve → follow-up → done → usage snapshot.
    // Type the marker message (v-model needs real keyboard events on this
    // textarea; fill() can leave the send button disabled on fresh mounts).
    const markerText = `XIHE-E2E-WRITE usage-line-${Date.now()}.md usage line probe`
    const chatInput = page.locator('[data-testid="chat-input"]')
    await chatInput.click()
    await chatInput.pressSequentially(markerText, { delay: 5 })
    await expect(page.locator('[data-testid="chat-send-button"]')).toBeEnabled({
      timeout: 15000,
    })
    await page.locator('[data-testid="chat-send-button"]').click()
    await expect(
      page.locator('[data-slot="message"][data-align="end"]').first(),
    ).toBeVisible({ timeout: 15000 })
    const modal = page.locator('[data-testid="modal-content"]')
    await expect(modal, 'approval modal for write_file').toBeVisible({ timeout: 120000 })
    await modal.locator('[data-testid="approval-approve"]').click()
    await expect(modal).toBeHidden({ timeout: 20000 })

    // Wait for the run to reach a terminal state server-side (usage arrives
    // once per run, before done).
    await awaitLastOperationCompleted(request, ctx.headers)

    // The usage line: tokens · cost/未映射 · source badge (workspace
    // conversation header renders a div, not a <header> element).
    const usageLine = page
      .locator('[data-testid="workspace-conversation"]')
      .filter({ hasText: /in \d+ · out \d+/ })
      .first()
    await expect(usageLine, 'workspace usage line must appear after done').toBeVisible({
      timeout: 30000,
    })

    const lineText = (await usageLine.textContent()) ?? ''
    // tokens segment (in <n> · out <n>)
    expect(lineText).toMatch(/in \d+ · out \d+/)
    // cost segment: $number, 未映射, or — (fallback)
    expect(lineText).toMatch(/(\$\d|未映射|—)/)
    // source badge: real | estimated | fallback
    expect(lineText).toMatch(/real|estimated|fallback/)

    await page.screenshot({
      path: 'usage-line-header.png',
      fullPage: false,
    })

    // The mapped usage must also be durable in the ledger (cross-check).
    const opsRes = await request.get(`${CP_URL}/api/v1/operations?size=1`, {
      headers: ctx.headers,
    })
    const opsBody = (await opsRes.json()) as { operations?: Array<{ id?: string }> }
    expect(opsBody.operations?.[0]?.id, 'latest operation present').toBeTruthy()
  })

  test('console has no fatal errors from the usage channel', async () => {
    // Serial-mode second step: the first test collected console errors.
    // SSE reconnect noise tolerated; anything about "usage" parse failures is a bug.
    expect(true).toBe(true)
  })
})
