// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import {
    CP_URL,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";
import { agentName } from "./helpers/agent-name";
import { ensureFakeUserProvider } from "./helpers/fake-provider";
import { workspaceChatPath } from "../../src/lib/routes";
import { LONG_TIMEOUT_MS } from "../timeouts";

/**
 * PLAN-0670 M2d —— first-paint probe（Lead 2026-11-05 要求）：
 * 门禁的 `renderMs=180s` 是"等待渲染全量"的超时时长，不是用户感知的首屏。
 * 这里测**页面导航 → 第一条 [data-message-role] 出现**的真实耗时，覆盖 1k/5k/20k 三档
 * （窗口化 + 分页后三档首屏都是同一页，预期近似常数）。
 */
const EVIDENCE_DIR = (() => {
    const hostRoot = process.env.XIHE_WORKSPACE_HOST_ROOT;
    if (hostRoot)
        return path.join(path.resolve(hostRoot, "../../../.."), ".local", "evidence", "plan-0670");
    const threeUp = path.resolve(process.cwd(), "../../..");
    const oneRoot = path.basename(threeUp) === ".worktrees" ? path.resolve(threeUp, "..") : threeUp;
    return path.join(oneRoot, ".local", "evidence", "plan-0670");
})();

const TIERS = [
    { label: "1k", count: 1_000 },
    { label: "5k", count: 5_000 },
    { label: "20k", count: 20_000 },
];

function psql(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "first-paint probe needs the isolated e2e-host PostgreSQL fixture metadata",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: LONG_TIMEOUT_MS, windowsHide: true },
    ).trim();
}

async function rootBranchId(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
): Promise<string> {
    const response = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}/branches`, {
        headers,
    });
    expect(response.ok(), await response.text()).toBe(true);
    const body = (await response.json()) as {
        items?: Array<{ branchId: string; parentBranchId?: string | null }>;
    };
    const root = (body.items ?? []).find((branch) => !branch.parentBranchId);
    expect(root?.branchId, "root branch must exist").toBeTruthy();
    return root!.branchId;
}

function seedMessages(sessionId: string, branchId: string, count: number): void {
    psql(`INSERT INTO messages (id, session_id, branch_id, role, content, created_at)
SELECT gen_random_uuid(), '${sessionId}', '${branchId}',
       CASE WHEN i % 2 = 0 THEN 'USER' ELSE 'ASSISTANT' END,
       'first-paint message ' || i,
       now() + (i || ' milliseconds')::interval
FROM generate_series(1, ${count}) AS i`);
}

async function measureFirstPaint(
    page: Page,
    url: string,
): Promise<{ firstPaintMs: number; rendered: number }> {
    const startedAt = Date.now();
    await page.goto(url);
    await page.waitForSelector("[data-message-role]", { timeout: LONG_TIMEOUT_MS });
    const firstPaintMs = Date.now() - startedAt;
    const rendered = await page.locator("[data-message-role]").count();
    return { firstPaintMs, rendered };
}

test.describe("@host PLAN-0670 M2d first-paint probe", () => {
    test("first message row appears in bounded time for 1k/5k/20k", async ({ page, request }) => {
        test.skip(!process.env.XIHE_E2E_PG_CONTAINER, "requires the isolated e2e-host stack");
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const ctx = await registerJourneyUser(request, "plan0670-firstpaint");
        const wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await waitForControlPlaneAgentReady(request, headers);
        const auth = { accessToken: ctx.authToken, workspaceId: wsId };
        await ensureFakeUserProvider(request, auth);
        const principalId = await provisionWorkspaceAgentPrincipal(request, auth, {
            name: agentName("FirstPaint", Date.now()),
            actions: ["read"],
            systemPrompt: "Reply briefly.",
        });
        await seedPage(page, ctx);

        const results: Array<{
            label: string;
            count: number;
            firstPaintMs: number;
            rendered: number;
            sessionId: string;
        }> = [];
        for (const tier of TIERS) {
            const sessionId = await createSessionWithPrincipal(request, auth, {
                principalId,
                title: `first-paint ${tier.label}`,
                workspaceId: wsId,
            });
            const branchId = await rootBranchId(request, headers, sessionId);
            seedMessages(sessionId, branchId, tier.count);
            const { firstPaintMs, rendered } = await measureFirstPaint(
                page,
                workspaceChatPath(wsId, sessionId),
            );
            results.push({
                label: tier.label,
                count: tier.count,
                firstPaintMs,
                rendered,
                sessionId,
            });
            writeFileSync(
                path.join(EVIDENCE_DIR, "m2d-first-paint.json"),
                JSON.stringify(
                    {
                        plan: "PLAN-0670",
                        task: "M2d first-paint",
                        results,
                        observedAt: new Date().toISOString(),
                    },
                    null,
                    2,
                ),
            );
        }

        writeFileSync(
            path.join(EVIDENCE_DIR, "m2d-first-paint.json"),
            JSON.stringify(
                {
                    plan: "PLAN-0670",
                    task: "M2d first-paint",
                    results,
                    observedAt: new Date().toISOString(),
                },
                null,
                2,
            ),
        );
        const report = results
            .map(
                (row) =>
                    `${row.label}: firstPaint=${row.firstPaintMs}ms rendered=${row.rendered}/${row.count}`,
            )
            .join(" | ");
        test.info().annotations.push({ type: "first-paint", description: report });
        expect(results).toHaveLength(3);
        for (const row of results) {
            expect(row.firstPaintMs, `${row.label} first paint must be bounded`).toBeLessThan(
                30_000,
            );
            expect(row.rendered, `${row.label} must render the first page`).toBeGreaterThan(0);
        }
    });
});
