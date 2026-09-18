/**
 * PLAN-0342 T2.2 — diagnostics feedback Host E2E (@host).
 *
 * Run (from A03-xihe, no --skip-runtime: diagnostics need real sandbox exec):
 *   XIHE_E2E_LLM_MODE=exec_command node scripts/e2e-host.mjs e2e/real/diagnostics.spec.ts
 *
 * Covers:
 * - V1/V2/V3: L0 parse hit → diagnostics visible in the tool card, raw output
 *   preserved in the (collapsed) fallback, and the next LLM turn actually saw
 *   the injected block (fake-llm echoes DIAG-VISIBLE from the tool message).
 * - V4: continuous-repeat suppression, then regression re-injection after a
 *   success round.
 * - V8: desktop + mobile evidence (DOM, computed style, screenshot,
 *   console/pageerror, horizontal-overflow check).
 */
import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test"
import {
  CP_URL,
  evidenceDir,
  registerJourneyUser,
  seedPage,
  type JourneyContext,
} from "./helpers/journey"

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock"
const EVIDENCE_DIR = evidenceDir("diagnostics")
const TERMINAL_RUN_PATTERN = /^(succeeded|failed|partial|ambiguous|cancelled)$/
const TERMINAL_OPERATION_OR_NONE = /^(completed|failed|cancelled|interrupted|ambiguous|none)$/

function record(scenario: string, observed: Record<string, unknown>): void {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  appendFileSync(
    path.join(EVIDENCE_DIR, "host.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), mode: LLM_MODE, scenario, observed })}\n`,
  )
}

function failCommand(location: string): string {
  return `XIHE-E2E-EXEC echo "${location}: error: mismatched types" >&2 && exit 1`
}

// ── CP API helpers ──────────────────────────────────────────────────────────

async function runStatus(
  request: APIRequestContext,
  headers: Record<string, string>,
  runId: string,
): Promise<string> {
  const res = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, { headers })
  if (!res.ok()) return `http-${res.status()}`
  return ((await res.json()) as { status?: string }).status ?? "unknown"
}

async function awaitPreviousRunSettled(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers })
        const body = (await res.json()) as { operations?: Array<{ status?: string }> }
        return body.operations?.[0]?.status ?? "none"
      },
      { timeout: 180000, intervals: [1000, 2000] },
    )
    .toMatch(TERMINAL_OPERATION_OR_NONE)
}

async function awaitRunTerminal(
  request: APIRequestContext,
  headers: Record<string, string>,
  runId: string,
): Promise<string> {
  await expect
    .poll(() => runStatus(request, headers, runId), { timeout: 180000, intervals: [1000, 2000] })
    .toMatch(TERMINAL_RUN_PATTERN)
  return runStatus(request, headers, runId)
}

// ── Browser helpers (no fixed sleeps) ───────────────────────────────────────

async function openWorkspace(page: Page, ctx: JourneyContext): Promise<void> {
  seedPage(page, ctx)
  await page.goto(`/workspace/${ctx.workspaceId}`, { waitUntil: "load" })
  await expect(page.locator('[data-testid="chat-input"]'), "workspace chat input").toBeVisible({
    timeout: 30000,
  })
}

async function startRun(scope: Page | Locator, text: string): Promise<string> {
  const input = scope.locator('[data-testid="chat-input"]')
  const send = scope.locator('[data-testid="chat-send-button"]')
  await expect(input).toBeVisible({ timeout: 30000 })
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await input.click().catch(() => {})
    await input.fill(text).catch(() => {})
    try {
      await expect(send).toBeEnabled({ timeout: 8000 })
    } catch {
      continue
    }
    const posted = scope
      .locator("body")
      .page()
      .waitForResponse(
        (response) =>
          response.url().endsWith("/api/v1/chat") && response.request().method() === "POST",
        { timeout: 20000 },
      )
      .catch(() => null)
    await send.click().catch(() => {})
    const response = await posted
    if (!response) continue
    const body = (await response.json().catch(() => ({}))) as { runId?: string }
    if (body.runId) return body.runId
  }
  throw new Error("chat send never returned a runId (POST /api/v1/chat)")
}

/**
 * Click the approval card when the manual policy shows one.
 *
 * On mobile the pending-approval modal lives inside the chat sheet's
 * ChatPanel; reka's dismissable layer closes the sheet on the modal's outside
 * focus/pointer events, which unmounts the card (`ChatPanel v-if="open"`).
 * With `reopenChat` the helper keeps clicking the sheet trigger so the card
 * reappears — the real user recovery path for this pre-existing behavior
 * (recorded under PLAN-0342 decision #14 / known issue).
 */
async function approveCardIfShown(
  page: Page,
  opts: { reopenChat?: boolean } = {},
): Promise<boolean> {
  const card = page
    .locator('[data-testid="approval-approve"], [data-testid="approval-allow-session"]')
    .first()
  const openChat = page.getByRole("button", { name: /open chat/i })

  const appeared = await expect
    .poll(
      async () => {
        if (await card.isVisible().catch(() => false)) return true
        if (opts.reopenChat && (await openChat.isVisible().catch(() => false))) {
          await openChat.click().catch(() => {})
        }
        return false
      },
      { timeout: 60_000, intervals: [500, 1000] },
    )
    .toBe(true)
    .then(() => true)
    .catch(() => false)
  if (!appeared) return false

  await card.click({ timeout: 15_000 })
  await expect(card).toBeHidden({ timeout: 60_000 })
  return true
}

/** Reopen the mobile chat sheet after a run if it was dismissed. */
async function ensureChatSheetOpen(page: Page): Promise<void> {
  const root = page.getByTestId("mobile-chat-sheet")
  if (await root.isVisible().catch(() => false)) return
  const openChat = page.getByRole("button", { name: /open chat/i })
  await expect(openChat).toBeVisible({ timeout: 15_000 })
  await openChat.click()
  await expect(root).toBeVisible({ timeout: 15_000 })
}

async function sendCommand(
  request: APIRequestContext,
  ctx: JourneyContext,
  scope: Page | Locator,
  command: string,
  opts: { reopenChat?: boolean } = {},
): Promise<string> {
  await awaitPreviousRunSettled(request, ctx.headers)
  const runId = await startRun(scope, command)
  const page = scope.locator("body").page()
  await approveCardIfShown(page, opts)
  const status = await awaitRunTerminal(request, ctx.headers, runId)
  expect(status, `run ${runId} terminal status`).toBe("succeeded")
  return runId
}

function diagnosticsBlocks(scope: Page | Locator) {
  return scope.locator('[data-testid="tool-diagnostics"]')
}

// ── Spec ────────────────────────────────────────────────────────────────────

test.describe.configure({ mode: "serial" })

test.describe("@host diagnostics feedback", () => {
  test.setTimeout(420_000)

  let ctx: JourneyContext
  test.beforeAll(async ({ request }) => {
    ctx = await registerJourneyUser(request, "diag")
  })

  test("V1/V2/V3/V8: parse hit is injected, model-visible, and rendered", async ({
    page,
    request,
  }) => {
    test.skip(LLM_MODE !== "exec_command", `requires XIHE_E2E_LLM_MODE=exec_command (current: ${LLM_MODE})`)
    const pageErrors: string[] = []
    page.on("pageerror", (error) => pageErrors.push(String(error)))

    await openWorkspace(page, ctx)
    const runId = await sendCommand(request, ctx, page, failCommand("src/main.rs:12:5"))
    void runId

    const block = diagnosticsBlocks(page).last()
    await expect(block, "structured diagnostics block").toBeVisible({ timeout: 30000 })
    await expect(block.locator('[data-testid="diagnostic-item-0"]')).toContainText("src/main.rs:12:5")
    await expect(block.locator('[data-testid="diagnostic-item-0"]')).toContainText("mismatched types")

    // PLAN-0342 review fix: call/result ids differ on the wire; exactly one
    // card per tool call (no ghost "running" card) must render.
    await expect(page.locator('[data-testid="tool-card-toggle"]')).toHaveCount(1)

    // The next LLM turn saw the diagnostics block (fake-llm echo).
    await expect(
      page.locator('[data-slot="message"][data-align="start"]').last(),
      "assistant follow-up reflecting model visibility",
    ).toContainText("DIAG-VISIBLE", { timeout: 30000 })

    // Decision #7: raw fallback is collapsed while diagnostics are shown.
    const toggle = page.locator('[data-testid="raw-output-toggle"]').last()
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute("aria-expanded", "false")
    const card = page.locator('[data-testid="tool-card-toggle"]').last().locator("xpath=..")
    await expect(card.locator("pre")).toHaveCount(0)
    await toggle.click()
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    await expect(card.locator('[data-testid="raw-result"]')).toContainText("mismatched types")

    // Presentation evidence (DOM + computed style + screenshot).
    const severity = block.locator('[data-testid="diagnostic-item-0"] span').first()
    const severityClass = (await severity.getAttribute("class")) ?? ""
    const severityColor = await severity.evaluate((el) => getComputedStyle(el).color)
    expect(severityClass).toContain("text-destructive")

    await page.screenshot({ path: path.join(EVIDENCE_DIR, "desktop-diagnostics.png") })
    record("v1-v3-desktop", {
      runId,
      severityClass,
      severityColor,
      diagnosticsText: await block.innerText(),
      modelVisible: true,
      pageErrors,
    })
    expect(pageErrors, "no uncaught page errors").toEqual([])
  })

  test("V4: repeat suppressed, regression after success re-injected", async ({ page, request }) => {
    test.skip(LLM_MODE !== "exec_command", `requires XIHE_E2E_LLM_MODE=exec_command (current: ${LLM_MODE})`)
    await openWorkspace(page, ctx)

    // Establish the diagnostic state inside this test so the assertion does
    // not depend on session continuity with the previous test (a fresh
    // session injects on the first run; a continuing session may suppress it).
    const baseline = await diagnosticsBlocks(page).count()
    const firstRun = await sendCommand(request, ctx, page, failCommand("src/main.rs:12:5"))
    const afterFirst = await diagnosticsBlocks(page).count()
    expect(afterFirst).toBeGreaterThanOrEqual(baseline)

    const repeatRun = await sendCommand(request, ctx, page, failCommand("src/main.rs:12:5"))
    await expect
      .poll(() => diagnosticsBlocks(page).count(), { timeout: 30000, intervals: [500, 1000] })
      .toBe(afterFirst)

    const successRun = await sendCommand(request, ctx, page, "XIHE-E2E-EXEC echo ok")
    await expect(diagnosticsBlocks(page)).toHaveCount(afterFirst)

    const regressionRun = await sendCommand(request, ctx, page, failCommand("src/main.rs:12:5"))
    await expect
      .poll(() => diagnosticsBlocks(page).count(), { timeout: 30000, intervals: [500, 1000] })
      .toBe(afterFirst + 1)
    await expect(diagnosticsBlocks(page).last()).toContainText("src/main.rs:12:5")

    record("v4-dedup", { baseline, afterFirst, firstRun, repeatRun, successRun, regressionRun })
  })

  test("V8 mobile: diagnostics render at 390x844 without horizontal overflow", async ({
    page,
    request,
  }) => {
    test.skip(LLM_MODE !== "exec_command", `requires XIHE_E2E_LLM_MODE=exec_command (current: ${LLM_MODE})`)
    await page.setViewportSize({ width: 390, height: 844 })
    seedPage(page, ctx)
    await page.goto(`/workspace/${ctx.workspaceId}`, { waitUntil: "load" })

    // Mobile composes inside a sheet (viewport-matrix convention).
    const openChat = page.getByRole('button', { name: /open chat/i })
    if (await openChat.isVisible({ timeout: 10000 }).catch(() => false)) {
      await openChat.click()
    }
    const root = page.getByTestId("mobile-chat-sheet")
    await expect(root).toBeVisible({ timeout: 15000 })
    await expect(root.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 15000 })

    // No-column variant + distinct identity so dedup does not suppress it.
    // reopenChat: the pending-approval modal dismisses the sheet (pre-existing
    // reka behavior); the helper re-opens it until the card is clickable.
    const runId = await sendCommand(request, ctx, root, failCommand("tests/test_a.py:7"), {
      reopenChat: true,
    })
    await ensureChatSheetOpen(page)
    const block = diagnosticsBlocks(root).last()
    await expect(block).toBeVisible({ timeout: 30000 })
    await expect(block).toContainText("tests/test_a.py:7")

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(overflow, "horizontal overflow px").toBeLessThanOrEqual(1)

    await page.screenshot({ path: path.join(EVIDENCE_DIR, "mobile-diagnostics.png") })
    record("v8-mobile", { runId, overflow })
  })
})
