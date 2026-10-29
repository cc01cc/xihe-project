/**
 * PLAN-0348 V4 — isolated host negative E2E for Session↔Workspace isolation.
 *
 * Product design (spec/session/chat-session.md clauses 1–2; DEV-018):
 *  - a Session is pinned to one Workspace for its lifetime;
 *  - the Agent process owns exactly ONE MCP Workspace context, so a chat in a
 *    second Workspace fails closed with
 *    "MCP workspace context cannot be reused across workspaces".
 *
 * The spec drives Workspace A first (which makes the Agent discover A's MCP
 * tools and bind to A), then Workspace B on the same Agent process, and asserts
 * B fails closed. Workspace A does not need to reach a *succeeded* terminal: in
 * the write_file lane the workspace tool call pauses at the approval gate
 * (awaiting_approval), which already proves the Agent bound to A. It MUST NOT
 * call `ensureAgentWorkspaceBinding` — that restarts the Agent and would hide
 * the fail-closed behaviour (the false-green trap in verify.md V4).
 *
 * Run (isolated stack; never against a dev stack):
 *   node scripts/e2e-host.mjs --llm-mode=write_file \
 *     e2e/real/plan-0348-session-workspace-isolation.spec.ts
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import {
    CP_URL,
    ensureChatReady,
    registerJourneyUser,
    seedPage,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import {
    createSessionWithPrincipal,
    provisionWorkspaceAgentPrincipal,
} from "./helpers/agent-principal";

const RUN_ID = process.env.XIHE_E2E_RUN_ID ?? "";
const TERMINAL = /^(succeeded|failed|partial|cancelled|ambiguous)$/;

// A single Agent process binds one Workspace; a retry would register a new
// Workspace and produce a false result, so no retries.
test.describe.configure({ retries: 0 });
test.setTimeout(180_000);

test.skip(!RUN_ID, "requires an isolated host stack (scripts/e2e-host.mjs), never a dev stack");

async function latestRunStatus(
    request: APIRequestContext,
    headers: Record<string, string>,
    workspaceId: string,
): Promise<string> {
    const res = await request.get(
        `${CP_URL}/api/v1/audit/entries?type=chat_run&size=1&workspaceId=${encodeURIComponent(workspaceId)}`,
        { headers },
    );
    if (!res.ok()) return `http-${res.status()}`;
    const body = (await res.json()) as { entries?: Array<{ status?: string }> };
    return body.entries?.[0]?.status ?? "none";
}

test("@host Workspace B chat fails closed once the Agent is bound to Workspace A", async ({
    page,
    request,
    browser,
}) => {
    // BL-145 (ordering dependency, bisect negative): green in isolation and in
    // every 2-spec neighbour combination tried on 2026-10-29 (single 8.9s;
    // +mcp-stdio 8.0s; +model-selection-identity 9.0s), but red in the full
    // `mock-full` matrix (run status `failed`, 2.7s, «Workspace A must bind the
    // Agent without failing»). The polluter was not isolated within the agreed
    // 10-minute bisect budget and the 9-10 minute full matrix is too expensive
    // as a reproduction oracle. Tracked as BL-145 「plan-0348 整批内顺序依赖：
    // 单跑绿/整批红，污染源未定位」; assertions are preserved — remove `fixme`
    // once the polluter is found.
    test.fixme(
        true,
        "BL-145: ordering-dependent red only in the full matrix; single-spec and 2-spec neighbour runs are green (bisect negative)",
    );
    // ── Workspace A: a workspace-tool chat makes the Agent bind to A.
    const a = await registerJourneyUser(request, "plan0348-ws-a");
    const authA = { accessToken: a.authToken, workspaceId: a.workspaceId };
    await waitForControlPlaneAgentReady(request, a.headers);
    const principalA = await provisionWorkspaceAgentPrincipal(request, authA, {
        name: "PLAN-0348 A",
        actions: ["read", "write"],
    });
    const sessionA = await createSessionWithPrincipal(request, authA, {
        principalId: principalA,
        title: "PLAN-0348 Workspace A",
    });
    seedPage(page, a);
    await page.goto(`/workspace/${a.workspaceId}/chat/${sessionA}`);
    await expect(page.getByTestId("chat-input")).toBeVisible();
    // The write_file lane's fake LLM emits a deterministic workspace tool call
    // for the XIHE-E2E-WRITE marker; reaching it means the Agent discovered A's
    // MCP tools (i.e. it is now bound to Workspace A).
    await sendChat(page, "XIHE-E2E-WRITE plan0348-a.txt hello-from-workspace-a");
    await expect
        .poll(() => latestRunStatus(request, a.headers, a.workspaceId), { timeout: 60_000 })
        .toMatch(/^(succeeded|failed|partial|cancelled|ambiguous|awaiting_approval)$/);
    const statusA = await latestRunStatus(request, a.headers, a.workspaceId);
    expect(statusA, "Workspace A must bind the Agent without failing").not.toBe("failed");

    // ── Workspace B (separate account): the Agent is already bound to A.
    const b = await registerJourneyUser(request, "plan0348-ws-b");
    const authB = { accessToken: b.authToken, workspaceId: b.workspaceId };
    const principalB = await provisionWorkspaceAgentPrincipal(request, authB, {
        name: "PLAN-0348 B",
        actions: ["read", "write"],
    });
    const sessionB = await createSessionWithPrincipal(request, authB, {
        principalId: principalB,
        title: "PLAN-0348 Workspace B",
    });

    // Cross-workspace Session API access is denied without any dispatch.
    const foreignGet = await request.get(`${CP_URL}/api/v1/sessions/${sessionA}`, {
        headers: b.headers,
    });
    expect(foreignGet.status()).toBe(404);
    expect(((await foreignGet.json()) as { code?: string }).code).toBe("SESSION_NOT_FOUND");
    const foreignDelete = await request.delete(`${CP_URL}/api/v1/sessions/${sessionA}`, {
        headers: b.headers,
    });
    expect(foreignDelete.status()).toBe(404);

    // Sending in B must fail closed on the same Agent process (no restart).
    const contextB = await browser.newContext();
    try {
        const pageB = await contextB.newPage();
        seedPage(pageB, b);
        await pageB.goto(`/workspace/${b.workspaceId}/chat/${sessionB}`);
        await ensureChatReady(pageB);
        await sendChat(pageB, "workspace B probe (Agent already bound to A)");
        await expect
            .poll(() => latestRunStatus(request, b.headers, b.workspaceId), { timeout: 60_000 })
            .toMatch(TERMINAL);
        const statusB = await latestRunStatus(request, b.headers, b.workspaceId);
        expect(
            statusB,
            `Workspace B run must fail closed (Agent single-workspace binding), got ${statusB}`,
        ).toBe("failed");
    } finally {
        await contextB.close();
    }

    // Workspace A is unaffected.
    expect(await latestRunStatus(request, a.headers, a.workspaceId)).not.toBe("failed");
});
