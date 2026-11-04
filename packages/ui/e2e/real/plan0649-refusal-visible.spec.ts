import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import {
    CP_URL,
    awaitLatestChatRunCompleted,
    ensureAgentWorkspaceBinding,
    evidenceDir,
    getRootBranchId,
    registerJourneyUser,
    seedPage,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { seedUserGrantPermissions } from "./helpers/user-grants";

/**
 * PLAN-0649 T4.1/T4.2 — headed real-stack walkthrough (V1 + V2).
 *
 * Claim under test: a CP-decided refusal is **visible** (not silent) and **durable** (survives a
 * reload), while the tool body never reaches any carrier.
 *
 * Three carriers must agree on one `refusalCode`:
 *   1. durable   — `context_events.tool.result.payload` (sanitized at write),
 *   2. wire DTO  — `GET /api/v1/sessions/{id}/messages?branchId=` → `toolCalls[].refusalCode`,
 *   3. rendered  — the tool card's expanded `[data-testid="tool-refusal-code"]` (PLAN-0649 M3).
 *
 * The SSE hop is covered by `tests/unit/test_tool_refusal_observability.py` and `useSSE.spec.ts`
 * (M1/M3): the relay publishes the same payload object this spec reads from `context_events`.
 *
 * Why this file is not a copy of `plan0630-delegation-walkthrough.spec.ts`: 0630 asserts the child
 * session/PRIMARY/interactive half and reads the refusal as free-floating conversation text; 0649
 * asserts the *card* (refusal block + failure state) and the three-carrier equality. Both share the
 * same fixture recipe (real model, `maxCount=1` → second spawn refused) because that recipe is the
 * only known way to produce a real `DELEGATION_LIMIT_EXCEEDED` on a live stack.
 *
 * NOT RUN YET (PLAN-0649 M4 hand-off): this file is delivered compile-checked only — running it
 * needs a host stack + real provider key, which is the Lead's L2 trigger point. See
 * `evidence/m4-walkthrough.md` for what it is expected to prove and what stays unproven until then.
 */

const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
const MODEL_ID = process.env.XIHE_E2E_REAL_OPENAI_MODEL ?? "mimo-v2.6-flash";
const REAL_BASE = process.env.XIHE_E2E_REAL_OPENAI_BASE ?? "https://api.xiaomimimo.com/v1";
const REFUSAL_CODE = "DELEGATION_LIMIT_EXCEEDED";
const EVIDENCE_DIR = evidenceDir("plan-0649");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** CP keeps the placeholder verbatim; asserting on a prefix keeps the spec copy-tolerance free. */
const WITHHELD_PREFIX = "Tool result withheld";

function requireUuid(value: string | undefined, what: string): string {
    if (!value || !UUID_PATTERN.test(value)) {
        throw new Error(`Expected a UUID for ${what}, received: ${value ?? "(missing)"}`);
    }
    return value;
}

function psql(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE,
        dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", dbUser, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: 20_000, windowsHide: true },
    ).trim();
}

function scalar(sql: string): number {
    const value = psql(sql);
    if (!/^\d+$/.test(value)) throw new Error(`Expected a count from Postgres, received: ${value}`);
    return Number(value);
}

interface ConnectionView {
    id: string;
    providerId: string;
    revision: number;
    enabled: boolean;
    status: string;
    operation?: string;
}

interface HistoryToolCall {
    id: string;
    name: string;
    status: string;
    result?: string;
    refusalCode?: string;
}

interface HistoryMessage {
    id: string;
    role: string;
    toolCalls?: HistoryToolCall[];
}

async function ensureOpenAiCompatConnection(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<ConnectionView> {
    const apiKey = process.env.XIHE_E2E_REAL_XIAOMI_KEY;
    expect(apiKey, "real provider key (XIHE_E2E_REAL_XIAOMI_KEY) is required").toBeTruthy();
    const list = await request.get(`${CP_URL}/api/v1/provider-connections`, { headers });
    expect(list.ok(), await list.text()).toBeTruthy();
    const existing = (
        ((await list.json()) as { connections?: ConnectionView[] }).connections ?? []
    ).find(
        (item) =>
            item.providerId === "openai" &&
            item.enabled &&
            item.status === "READY" &&
            item.operation === "chat",
    );
    if (existing) return existing;
    const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
        headers,
        data: {
            providerId: "openai",
            apiTypeId: "openai-chat-completions",
            apiTypeVersion: 1,
            apiKey,
            connectionKey: "plan0649-refusal",
            label: "PLAN-0649 refusal walkthrough",
            scope: "USER",
            modelDiscovery: "manual",
            manualModels: [MODEL_ID],
            baseUrl: REAL_BASE,
        },
    });
    expect(
        created.ok(),
        `connection create ${created.status()}: ${await created.text()}`,
    ).toBeTruthy();
    const draft = (await created.json()) as ConnectionView;
    const verified = await request.post(
        `${CP_URL}/api/v1/provider-connections/${draft.id}/verify`,
        { headers },
    );
    expect(verified.ok(), `verify ${verified.status()}: ${await verified.text()}`).toBeTruthy();
    const connection = ((await verified.json()) as { connection: ConnectionView }).connection;
    expect(connection.status, "the real connection must verify READY").toBe("READY");
    return connection;
}

/**
 * The persisted card the UI renders after a reload comes from this DTO, so it is also the carrier
 * V2 names explicitly. `branchId` is required by the route (PLAN-0410).
 */
async function readToolCalls(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
    branchId: string,
): Promise<HistoryToolCall[]> {
    const response = await request.get(
        `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${branchId}`,
        { headers },
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    const messages = (await response.json()) as HistoryMessage[];
    return messages.flatMap((message) => message.toolCalls ?? []);
}

/** Expand every tool card so the expanded region (refusal block) is in the DOM. */
async function expandAllToolCards(page: Page): Promise<number> {
    const toggles = page.getByTestId("tool-card-toggle");
    const count = await toggles.count();
    for (let index = 0; index < count; index++) {
        await toggles
            .nth(index)
            .click()
            .catch(() => {});
    }
    return count;
}

test.describe("@host PLAN-0649 refusal visible + durable", () => {
    test.describe.configure({ mode: "serial", retries: 0 });

    test("a budget refusal is rendered on the card and survives a reload", async ({
        page,
        request,
    }) => {
        test.skip(
            !process.env.XIHE_E2E_REAL_XIAOMI_KEY,
            "requires a real provider key (XIHE_E2E_REAL_XIAOMI_KEY)",
        );
        test.skip(
            REAL_ROUTE !== "openai-compat",
            "requires XIHE_E2E_REAL_ROUTE=openai-compat (the runner imports the OpenAI-compatible provider config)",
        );
        test.setTimeout(900_000);
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const observed: Record<string, unknown> = {
            plan: "PLAN-0649",
            task: "T4.1/T4.2",
            route: REAL_ROUTE,
            model: MODEL_ID,
            expectedRefusalCode: REFUSAL_CODE,
        };
        const persist = (): void => {
            writeFileSync(
                path.join(EVIDENCE_DIR, "refusal-visible-observed.json"),
                JSON.stringify({ ...observed, observedAt: new Date().toISOString() }, null, 2),
            );
        };
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));

        // ── Fixture: user, workspace, real connection, delegating principal ──
        const ctx = await registerJourneyUser(request, "plan0649-refusal"),
            wsId = ctx.workspaceId,
            headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await ensureAgentWorkspaceBinding(wsId);
        await waitForControlPlaneAgentReady(request, headers);
        const meResponse = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
        expect(meResponse.ok(), await meResponse.text()).toBeTruthy();
        const userId = requireUuid(((await meResponse.json()) as { id: string }).id, "userId");
        seedUserGrantPermissions(userId, [
            { actionClass: "CREATE_ACCOUNT", resource: "*" },
            // Ceiling-set member (helpers/user-grants.ts standardWorkspaceUserPermissions):
            // the spec writes agent-templates below; without this atom the write is a 403 on
            // every environment — the original fixture omitted it and never ran.
            { actionClass: "CREATE_TEMPLATE", resource: "*" },
            { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: wsId },
            { actionClass: "SPAWN_AGENT", resource: "*" },
            { actionClass: "write", resource: "*" },
        ]);
        const connection = await ensureOpenAiCompatConnection(request, headers);

        const roleId = randomUUID(),
            templateId = randomUUID();
        const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers,
            data: {
                roles: JSON.stringify([
                    {
                        id: roleId,
                        name: "PLAN0649 Refusal Role",
                        permissions: [
                            { actionClass: "write", resource: "*" },
                            { actionClass: "SPAWN_AGENT", resource: "*" },
                        ],
                    },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "PLAN0649 Delegating Agent",
                        description: "CP-owned spawn_agent budget-refusal fixture",
                        systemPrompt:
                            "You are an orchestration agent. When the user asks you to spawn child agents, call the spawn_agent tool for each one. Reply concisely.",
                        // spawn_agent is a CP-owned MCP tool and only exists for a
                        // workspace-tool run (host-e2e §3).
                        toolMode: "workspace",
                        provider: "openai",
                        model: MODEL_ID,
                        roleId,
                    },
                ]),
            },
        });
        expect(templateWrite.status(), await templateWrite.text()).toBe(200);

        const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
            headers,
            data: { scope: "WORKSPACE", name: "PLAN0649 Delegator", templateId },
        });
        expect(principalResponse.status(), await principalResponse.text()).toBe(201);
        const principalId = requireUuid(
            ((await principalResponse.json()) as { principalId: string }).principalId,
            "principalId",
        );
        const boundAgent = await request.put(
            `${CP_URL}/api/v1/workspaces/${wsId}/agents/${principalId}`,
            {
                headers,
                data: {
                    permissions: [
                        { actionClass: "write", resource: "*" },
                        { actionClass: "SPAWN_AGENT", resource: "*" },
                    ],
                },
            },
        );
        expect(boundAgent.status(), await boundAgent.text()).toBe(200);

        // The materialized grant must carry SPAWN_AGENT, otherwise the tool is filtered out of
        // tools/list and no refusal can ever happen.
        const principalGrantId = requireUuid(
            psql(
                `SELECT id FROM grants WHERE subject_type = 'agent_principal' AND subject_id = '${principalId}'::uuid ORDER BY created_at DESC LIMIT 1`,
            ),
            "principal grant id",
        );
        psql(
            `UPDATE grants SET permissions = permissions || '[{"actionClass":"SPAWN_AGENT","resource":"*"}]'::jsonb WHERE id = '${principalGrantId}'::uuid AND NOT (permissions @> '[{"actionClass":"SPAWN_AGENT","resource":"*"}]'::jsonb)`,
        );

        // maxCount=1 → the second spawn of one run is refused while the first child is in flight.
        const delegationPolicy = await request.patch(
            `${CP_URL}/api/v1/agent-principals/${principalId}`,
            { headers, data: { delegationPolicy: { maxCount: 1, maxDepth: 2 } } },
        );
        expect(
            delegationPolicy.status(),
            `delegationPolicy ${delegationPolicy.status()}: ${await delegationPolicy.text()}`,
        ).toBe(200);

        const sessionResponse = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers,
            data: { title: "PLAN-0649 refusal visible", agentPrincipalId: principalId },
        });
        expect(sessionResponse.status(), await sessionResponse.text()).toBe(201);
        const sessionId = requireUuid(
            ((await sessionResponse.json()) as { id: string }).id,
            "sessionId",
        );
        const boundSession = await request.patch(`${CP_URL}/api/v1/sessions/${sessionId}`, {
            headers,
            data: {
                providerConnectionId: connection.id,
                modelProvider: connection.providerId,
                modelName: MODEL_ID,
                connectionRevision: connection.revision,
            },
        });
        expect(boundSession.ok(), `session bind ${await boundSession.text()}`).toBeTruthy();
        // The spawn gate is an approval gate; manual mode keeps the modal real (the refusal itself
        // happens before dispatch, so it does not depend on the approval outcome).
        psql(`UPDATE sessions SET approval_mode = 'manual' WHERE id = '${sessionId}'::uuid`);
        const branchId = await getRootBranchId(request, sessionId, headers);

        observed.workspaceId = wsId;
        observed.principalId = principalId;
        observed.sessionId = sessionId;
        observed.branchId = branchId;
        persist();

        // ── Step 1: one run, two spawn_agent calls, the second refused by the budget ──
        seedPage(page, ctx);
        await page.goto(`/workspace/${wsId}/chat/${sessionId}`, { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
        const modal = page.locator('[data-testid="modal-content"]');
        await sendChat(
            page,
            "请连续调用 spawn_agent 工具两次（必须两次都用工具调用，不要等第一次完成）：第一次 prompt 填「回复标记 REFUSAL-ONE」，第二次 prompt 填「回复标记 REFUSAL-TWO」。两次之间不要等待，也不要只调用一次。",
        );
        const approvalSeen = await modal
            .waitFor({ state: "visible", timeout: 180_000 })
            .then(() => true)
            .catch(() => false);
        if (approvalSeen) {
            await modal.locator('[data-testid="approval-approve"]').click();
            await expect(modal).toBeHidden({ timeout: 30_000 });
        }
        await awaitLatestChatRunCompleted(request, headers, wsId);

        // ── Step 2: carrier 1 — the durable event payload (refusal must be recorded there) ──
        await expect
            .poll(
                () =>
                    scalar(
                        `SELECT count(*) FROM context_events WHERE session_id = '${sessionId}'::uuid AND event_type = 'tool.result' AND payload ->> 'refusalCode' = '${REFUSAL_CODE}'`,
                    ),
                { timeout: 240_000, intervals: [2_000, 3_000] },
            )
            .toBeGreaterThan(0);
        const durablePayloadJson = psql(
            `SELECT payload::text FROM context_events WHERE session_id = '${sessionId}'::uuid AND event_type = 'tool.result' AND payload ->> 'refusalCode' = '${REFUSAL_CODE}' ORDER BY sequence DESC LIMIT 1`,
        );
        const durablePayload = JSON.parse(durablePayloadJson) as {
            status?: string;
            refusalCode?: string;
            result?: unknown;
        };
        expect(durablePayload.refusalCode).toBe(REFUSAL_CODE);
        expect(durablePayload.status, "the authoritative durable status is failed").toBe("failed");
        expect(
            String(durablePayload.result),
            "durable carrier must hold the CP placeholder, never the tool body",
        ).toContain(WITHHELD_PREFIX);
        const parentRunId = requireUuid(
            psql(
                `SELECT id FROM chat_runs WHERE session_id = '${sessionId}'::uuid AND origin = 'user_submission' ORDER BY created_at DESC LIMIT 1`,
            ),
            "parentRunId",
        );

        // ── Step 3: carrier 2 — the messages DTO the UI renders after a reload ──
        await expect
            .poll(
                async () => {
                    const cards = await readToolCalls(request, headers, sessionId, branchId);
                    return cards.filter((card) => card.refusalCode === REFUSAL_CODE).length;
                },
                { timeout: 120_000, intervals: [2_000, 3_000] },
            )
            .toBeGreaterThan(0);
        const cardsBeforeReload = await readToolCalls(request, headers, sessionId, branchId);
        const refusedCard = cardsBeforeReload.find((card) => card.refusalCode === REFUSAL_CODE);
        expect(refusedCard, "the messages DTO carries the refusal code").toBeTruthy();
        expect(refusedCard?.name).toBe("spawn_agent");
        expect(refusedCard?.status, "the DTO status is the same failed status").toBe("failed");
        expect(
            String(refusedCard?.result),
            "DTO carrier must hold the CP placeholder, never the tool body",
        ).toContain(WITHHELD_PREFIX);

        // ── Step 4: carrier 3 — the rendered card (V1: visible, not silent) ──
        const cardCount = await expandAllToolCards(page);
        const refusalBlock = page.getByTestId("tool-refusal").first();
        await expect(refusalBlock, "the refusal block is rendered on the tool card").toBeVisible({
            timeout: 60_000,
        });
        await expect(page.getByTestId("tool-refusal-code").first()).toHaveText(REFUSAL_CODE);
        const liveShot = path.join(EVIDENCE_DIR, "refusal-card-live.png");
        await page.screenshot({ scale: "css", path: liveShot, fullPage: false });

        // ── Step 5: V2 — reload and require the same three carriers to still agree ──
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
        const reloadedCardCount = await expandAllToolCards(page);
        await expect(page.getByTestId("tool-refusal").first(), {
            message: "the refusal block survives a full reload (durable snapshot rendering)",
        }).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId("tool-refusal-code").first()).toHaveText(REFUSAL_CODE);
        const cardsAfterReload = await readToolCalls(request, headers, sessionId, branchId);
        const reloadedRefused = cardsAfterReload.find((card) => card.refusalCode === REFUSAL_CODE);
        expect(reloadedRefused?.status).toBe("failed");
        const reloadShot = path.join(EVIDENCE_DIR, "refusal-card-reloaded.png");
        await page.screenshot({ scale: "css", path: reloadShot, fullPage: false });

        observed.carriers = {
            durable: {
                refusalCode: durablePayload.refusalCode,
                status: durablePayload.status,
                resultIsPlaceholder: String(durablePayload.result).startsWith(WITHHELD_PREFIX),
            },
            dto: {
                refusalCode: refusedCard?.refusalCode,
                status: refusedCard?.status,
                resultIsPlaceholder: String(refusedCard?.result).startsWith(WITHHELD_PREFIX),
                cardCount: cardsBeforeReload.length,
                afterReloadCardCount: cardsAfterReload.length,
            },
            dom: {
                toolCardCount: cardCount,
                afterReloadToolCardCount: reloadedCardCount,
                refusalCodeText: REFUSAL_CODE,
                screenshots: [liveShot, reloadShot],
            },
        };
        observed.threeWayEqual =
            durablePayload.refusalCode === refusedCard?.refusalCode &&
            refusedCard?.refusalCode === REFUSAL_CODE;
        persist();

        // The DTO is deterministic across the reload (same durable snapshot → same cards).
        expect(cardsAfterReload, "the message snapshot is stable across a reload").toEqual(
            cardsBeforeReload,
        );
        expect(observed.threeWayEqual, "all three carriers must agree on one refusal code").toBe(
            true,
        );
        expect(scalar(`SELECT count(*) FROM chat_runs WHERE id = '${parentRunId}'::uuid`)).toBe(1);
        expect(pageErrors, "no page errors during the walkthrough").toEqual([]);
    });
});
