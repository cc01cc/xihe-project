// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
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
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

import { agentName } from "./helpers/agent-name";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";
const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";
const PROJECT_DIR = path.resolve(process.cwd(), "../..");
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ?? path.join(PROJECT_DIR, ".tmp", "e2e-host", RUN_ID);
const NONCE = Date.now().toString(36);
const TERMINAL = /^(succeeded|failed|partial|ambiguous|cancelled)$/;

test.describe("@host PLAN-0550 checkpoint reason GIT_FAILED", () => {
    test.describe.configure({ mode: "serial", retries: 0 });

    let ctx: JourneyContext;
    let sessionId = "";

    test.beforeAll(async ({ request }) => {
        test.skip(!RUN_ID, "requires the isolated host stack (XIHE_E2E_RUN_ID)");
        ctx = await registerJourneyUser(request, "plan0550-reason");
        const principalId = await provisionWorkspaceAgentPrincipal(
            request,
            { accessToken: ctx.authToken, workspaceId: ctx.workspaceId },
            { name: agentName("Plan0550", NONCE), actions: ["read", "write"] },
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
        // BL-142 / task-78：seam 已重写，用例恢复真跑（不再 skip）。
        // 旧 seam 只 park `objects`，Runtime 在 run start 会把被掏空的 shadow repo 重新
        // bootstrap（`runtime.log`: "shadow git repository bootstrapped"），checkpoint 终态
        // `captured` 而非 `degraded`（2026-10-29 mock 与 write_file 两车道复现）。
        // 新 seam 同时做两件事，把自愈短路掉：
        //   1. 在 shadow repo 根落 `.xihe-bootstrapped`（`checkpoint.rs` BOOTSTRAP_MARKER，
        //      `ensure_initialized` 命中即 return Ok(())），Runtime 不再 init/修配置；
        //   2. `objects` 改名后在原位放一个同名**普通文件**，git 无法在其下建临时对象目录
        //      （ENOTDIR）⇒ 捕获必然失败、degraded + GIT_FAILED 稳定外露。
        // 判据不变（state=degraded / unrollableReason=GIT_FAILED / 标记文案），finally 完整还原。
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
                timeout: LONG_TIMEOUT_MS,
                intervals: [1000, 2000, 3000],
                message: "shadow objects must exist after materialize",
            })
            .toBe(true);
        const parked = `${objects}.plan0550-bak`;
        const bootstrapMarker = path.join(shadowDir, ".xihe-bootstrapped");
        const hadBootstrapMarker = existsSync(bootstrapMarker);
        try {
            renameSync(objects, parked);
            writeFileSync(objects, "plan0550: objects is a file, not a directory\n");
            writeFileSync(bootstrapMarker, "bootstrapped\n");
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
            await expect(marker).toBeVisible({ timeout: LONG_TIMEOUT_MS });
            await expect(marker).toContainText(/git 操作失败|Git failed/i, {
                timeout: LONG_TIMEOUT_MS,
            });
            await page.screenshot({
                scale: "css",
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
            if (existsSync(objects) && !statSync(objects).isDirectory()) unlinkSync(objects);
            if (existsSync(parked) && !existsSync(objects)) renameSync(parked, objects);
            if (!hadBootstrapMarker && existsSync(bootstrapMarker)) unlinkSync(bootstrapMarker);
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
    await page.goto(`/workspace/${ctx.workspaceId}/session/${sessionId}`, { waitUntil: "load" });
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
    await ensureChatBinding(page, sessionId);
    await waitForControlPlaneAgentReady(request, ctx.headers);

    const input = page.locator('[data-testid="chat-input"]');
    const send = page.locator('[data-testid="chat-send-button"]');
    for (let attempt = 0; attempt < 4; attempt += 1) {
        await input.click().catch(() => {});
        await input.fill(text).catch(() => {});
        try {
            await expect(send).toBeEnabled({ timeout: EXPECT_TIMEOUT_MS });
        } catch {
            continue;
        }
        const posted = page
            .waitForResponse(
                (response) =>
                    response.url().endsWith("/api/v1/chat") &&
                    response.request().method() === "POST",
                { timeout: LONG_TIMEOUT_MS },
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
