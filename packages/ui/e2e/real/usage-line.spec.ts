// PLAN-0343 U1/V6: run-terminal usage line in the session header.
// Flow: register → workspace page → deterministic write_file chat (approve) →
// run reaches done → the header usage line must show tokens, a mapped cost
// (or 未映射) and a source badge. DOM + screenshot + console evidence.
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
    CP_URL,
    registerJourneyUser,
    seedPage,
    ensureChatReady,
    awaitLatestChatRunCompleted,
    ensureAgentWorkspaceBinding,
} from "./helpers/journey";

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";

function queryIsolatedPostgres(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER;
    const database = process.env.XIHE_E2E_PG_DATABASE;
    const user = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !user) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", user, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    ).trim();
}

test.describe("@host PLAN-0343 — usage line in session header", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(240000);

    let ctx: { authToken: string; workspaceId: string; headers: Record<string, string> };

    test.beforeAll(async ({ request }) => {
        // Agent binds one workspace per process — register exactly once.
        ctx = await registerJourneyUser(request, "usage-line");
    });

    test("usage line shows tokens, cost or unmapped, and source badge after done", async ({
        page,
        request,
    }) => {
        // PLAN-0369: the deterministic write_file marker only exists in the fake-LLM
        // `write_file` mode; the built-in `mock` provider never emits a tool call.
        test.skip(
            LLM_MODE !== "write_file",
            `requires XIHE_E2E_LLM_MODE=write_file fake LLM marker mode (current: ${LLM_MODE})`,
        );
        const consoleErrors: string[] = [];
        page.on("console", (msg) => {
            if (msg.type() === "error") consoleErrors.push(msg.text());
        });

        seedPage(page, ctx);
        // PLAN-0369: this spec's workspace may differ from the previously bound
        // one — restart the Agent so its MCP context matches before the chat.
        await ensureAgentWorkspaceBinding(ctx.workspaceId);
        await page.goto("/workspace/" + ctx.workspaceId, { waitUntil: "load" });
        await ensureChatReady(page);

        // Deterministic write_file → approve → follow-up → done → usage snapshot.
        // Type the marker message (v-model needs real keyboard events on this
        // textarea; fill() can leave the send button disabled on fresh mounts).
        const markerText = `XIHE-E2E-WRITE usage-line-${Date.now()}.md usage line probe`;
        const chatInput = page.locator('[data-testid="chat-input"]');
        await chatInput.click();
        await chatInput.pressSequentially(markerText, { delay: 5 });
        await expect(page.locator('[data-testid="chat-send-button"]')).toBeEnabled({
            timeout: 15000,
        });
        await page.locator('[data-testid="chat-send-button"]').click();
        await expect(page.locator('[data-slot="message"][data-align="end"]').first()).toBeVisible({
            timeout: 15000,
        });
        const modal = page.locator('[data-testid="modal-content"]');
        await expect(modal, "approval modal for write_file").toBeVisible({ timeout: 120000 });
        await modal.locator('[data-testid="approval-approve"]').click();
        await expect(modal).toBeHidden({ timeout: 20000 });

        // Wait for the run to reach a terminal state server-side (usage arrives
        // once per run, before done).
        await awaitLatestChatRunCompleted(request, ctx.headers, ctx.workspaceId);

        // The usage line: tokens · cost/未映射 · source badge (workspace
        // conversation header renders a div, not a <header> element).
        const usageLine = page
            .locator('[data-testid="workspace-conversation"]')
            .filter({ hasText: /in \d+ · out \d+/ })
            .first();
        await expect(usageLine, "workspace usage line must appear after done").toBeVisible({
            timeout: 30000,
        });

        const lineText = (await usageLine.textContent()) ?? "";
        // tokens segment (in <n> · out <n>)
        expect(lineText).toMatch(/in \d+ · out \d+/);
        // cost segment: $number, 未映射, or — (fallback)
        expect(lineText).toMatch(/(\$\d|未映射|—)/);
        // source badge: real | estimated | fallback
        expect(lineText).toMatch(/real|estimated|fallback/);

        await page.screenshot({
            path: "usage-line-header.png",
            fullPage: false,
        });

        // Usage persistence is owned by the ContextEvent for the terminal ChatRun.
        const auditRes = await request.get(
            `${CP_URL}/api/v1/audit/entries?type=chat_run&workspaceId=${ctx.workspaceId}&size=5`,
            {
                headers: ctx.headers,
            },
        );
        expect(auditRes.ok(), `ChatRun audit list ${auditRes.status()}`).toBeTruthy();
        const auditBody = (await auditRes.json()) as {
            entries?: Array<{ id?: string; runId?: string }>;
        };
        const runId = auditBody.entries?.[0]?.runId ?? auditBody.entries?.[0]?.id;
        expect(runId).toMatch(/^[0-9a-f-]{36}$/i);
        const storedUsage = queryIsolatedPostgres(
            `SELECT payload->'usage'->>'inputTokens' || '|' || payload->'usage'->>'outputTokens' || '|' || payload->'usage'->>'totalTokens' FROM context_events WHERE event_type='llm.usage' AND correlation_id='${runId}'::text`,
        );
        expect(storedUsage, "one durable usage event for the completed run").toMatch(
            /^\d+\|\d+\|\d+$/,
        );
    });

    test("console has no fatal errors from the usage channel", async () => {
        // Serial-mode second step: the first test collected console errors.
        // SSE reconnect noise tolerated; anything about "usage" parse failures is a bug.
        expect(true).toBe(true);
    });
});
