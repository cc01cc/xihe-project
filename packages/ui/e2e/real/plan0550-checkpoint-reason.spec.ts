/**
 * PLAN-0550 BL-119 (@host, isolated stack): a real Run whose shadow objects are
 * unavailable must surface `GIT_FAILED` through Runtime → CP durable row → UI.
 *
 * Run with:
 *   node scripts/e2e-host.mjs --llm-mode=write_file --retries=0 \
 *     e2e/real/plan0550-checkpoint-reason.spec.ts
 *
 * The shadow `objects` directory is renamed (not deleted) before the Run and is
 * restored in `finally`; the isolated stack is torn down by the runner.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    ensureChatBinding,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
    type JourneyContext,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";
const PROJECT_DIR = path.resolve(process.cwd(), "../..");
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ?? path.join(PROJECT_DIR, ".tmp", "e2e-host", RUN_ID);
const NONCE = Date.now().toString(36);
const TERMINAL = /^(succeeded|failed|partial|ambiguous|cancelled)$/;

test.describe("@host PLAN-0550 checkpoint reason GIT_FAILED", () => {
    test.describe.configure({ mode: "serial", retries: 0 });
    test.setTimeout(300000);

    let ctx: JourneyContext;
    let sessionId = "";

    test.beforeAll(async ({ request }) => {
        test.skip(!RUN_ID, "requires the isolated host stack (XIHE_E2E_RUN_ID)");
        ctx = await registerJourneyUser(request, "plan0550-reason");
        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: ctx.authToken, workspaceId: ctx.workspaceId },
            { name: `plan0550-${NONCE}`, actions: ["read", "write"] },
        );
        sessionId = await createSessionWithPrincipal(
            request,
            { accessToken: ctx.authToken, workspaceId: ctx.workspaceId },
            { principalId, title: "plan0550-reason" },
        );
        await ensureAgentWorkspaceBinding(ctx.workspaceId);
        await waitForControlPlaneAgentReady(request, ctx.headers);
    });

    test("GIT_FAILED propagates to CP durable state and the marker", async ({ page, request }) => {
        // BL-142 (test premise obsolete, needs a new forced-failure seam):
        // parking the shadow `objects` directory still makes the C0 materialize
        // checkpoint log `GIT_FAILED`, but the Runtime re-bootstraps the shadow
        // repo at run start (`runtime.log`: "shadow git repository bootstrapped"
        // immediately after "C0 checkpoint capture skipped ... GIT_FAILED") and
        // the run checkpoint ends `captured` instead of `degraded`. Reproduced in
        // both mock and write_file lanes (2026-10-29), so this spec's mechanism
        // no longer reaches the degraded surface. Self-heal appears to be a
        // deliberate Runtime capability (`checkpoint.rs` BOOTSTRAP_MARKER /
        // bootstrap path); whether `degraded` must still be surfaced for a
        // forced git failure is a product decision → rewrite the seam, do not
        // weaken the assertion. Tracked as BL-142.
        test.skip(
            true,
            "BL-142: Runtime self-heals a parked shadow repo, so run checkpoints no longer surface degraded/GIT_FAILED; needs a new forced-failure seam (and a product decision on the degraded contract)",
        );
        const hostDir = path.join(HOST_ROOT, ctx.workspaceId);
        mkdirSync(hostDir, { recursive: true });
        writeFileSync(path.join(hostDir, "seed.md"), "seed before corrupting shadow\n");

        const materialized = await request.post(
            `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/materialize`,
            { headers: ctx.headers },
        );
        expect(
            [200, 202],
            `materialize: ${materialized.status()} ${await materialized.text()}`,
        ).toContain(materialized.status());

        const shadowDir = path.join(HOST_ROOT, ".xihe-shadow", `${ctx.workspaceId}.git`);
        const objects = path.join(shadowDir, "objects");
        await expect
            .poll(() => existsSync(objects), {
                timeout: 180000,
                intervals: [1000, 2000, 3000],
                message: "shadow objects must exist after materialize",
            })
            .toBe(true);
        const parked = `${objects}.plan0550-bak`;
        try {
            renameSync(objects, parked);
            const runId = await startRun(
                page,
                request,
                ctx,
                sessionId,
                "write a file for plan0550",
            );
            await waitTerminal(request, ctx, runId);

            const row = await pollCheckpoint(request, ctx, runId);
            expect(row.state).toBe("degraded");
            expect(row.unrollableReason).toBe("GIT_FAILED");

            const marker = page.locator('[data-testid="run-checkpoint-marker"]').last();
            await expect(marker).toBeVisible({ timeout: 30000 });
            await expect(marker).toContainText(/git 操作失败|Git failed/i, { timeout: 30000 });
            await page.screenshot({ scale: "css",
                path: path.join(
                    PROJECT_DIR,
                    ".local",
                    "evidence",
                    "plan0550",
                    "git-failed-marker.png",
                ),
                fullPage: true,
            });
        } finally {
            if (existsSync(parked) && !existsSync(objects)) renameSync(parked, objects);
        }
    });
});

async function startRun(
    page: Page,
    request: APIRequestContext,
    ctx: JourneyContext,
    sessionId: string,
    text: string,
): Promise<string> {
    seedPage(page, ctx);
    await page.goto(`/workspace/${ctx.workspaceId}/chat/${sessionId}`, { waitUntil: "load" });
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 30000 });
    await ensureChatBinding(page, sessionId);
    await waitForControlPlaneAgentReady(request, ctx.headers);

    const input = page.locator('[data-testid="chat-input"]');
    const send = page.locator('[data-testid="chat-send-button"]');
    for (let attempt = 0; attempt < 4; attempt += 1) {
        await input.click().catch(() => {});
        await input.fill(text).catch(() => {});
        try {
            await expect(send).toBeEnabled({ timeout: 8000 });
        } catch {
            continue;
        }
        const posted = page
            .waitForResponse(
                (response) =>
                    response.url().endsWith("/api/v1/chat") &&
                    response.request().method() === "POST",
                { timeout: 20000 },
            )
            .catch(() => null);
        await send.click().catch(() => {});
        const response = await posted;
        if (!response) continue;
        const body = (await response.json().catch(() => ({}))) as { runId?: string };
        if (body.runId) return body.runId;
    }
    throw new Error("chat send never returned a runId");
}

async function waitTerminal(
    request: APIRequestContext,
    ctx: JourneyContext,
    runId: string,
): Promise<void> {
    for (let i = 0; i < 120; i += 1) {
        const response = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, {
            headers: ctx.headers,
        });
        if (response.ok()) {
            const body = (await response.json()) as { status?: string };
            if (body.status && TERMINAL.test(body.status)) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`run ${runId} did not reach a terminal state`);
}

async function pollCheckpoint(
    request: APIRequestContext,
    ctx: JourneyContext,
    runId: string,
): Promise<{ state: string; unrollableReason: string | null }> {
    for (let i = 0; i < 60; i += 1) {
        const response = await request.get(
            `${CP_URL}/api/v1/workspaces/${ctx.workspaceId}/checkpoints`,
            { headers: ctx.headers },
        );
        if (response.ok()) {
            const rows = (await response.json()) as Array<{
                sourceRunId: string | null;
                state: string;
                unrollableReason: string | null;
            }>;
            const row = rows.find((candidate) => candidate.sourceRunId === runId);
            if (row) return row;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`checkpoint row for ${runId} not found`);
}
