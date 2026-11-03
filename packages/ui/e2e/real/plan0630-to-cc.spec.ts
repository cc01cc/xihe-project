import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { seedUserGrant } from "./helpers/user-grants";
import { workspaceChatPath } from "../../src/lib/routes";

/**
 * PLAN-0630 M5b (D30-14) / T5b.4 — real-stack browser walkthrough of the composer
 * to/cc semantics on the MiMo OpenAI-compatible route.
 *
 * Contract under test (tasks.md T5b.4):
 *   - a two-Agent session: to = A, cc = B;
 *   - sending → A answers, B receives the durable notify but creates no Run;
 *   - `@B` → B answers passively (WHEN_MENTIONED).
 *
 * Evidence (task requirement: 3 screenshots) lands OUTSIDE the worktree in
 * `one/.local/evidence/plan-0630/` (host-e2e §6: evidence is copied out before
 * any worktree cleanup), and every step records the session/participant/run ids.
 */

const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
const MODEL_ID = process.env.XIHE_E2E_REAL_OPENAI_MODEL ?? "mimo-v2.6-flash";
const REAL_BASE = process.env.XIHE_E2E_REAL_OPENAI_BASE ?? "https://api.xiaomimimo.com/v1";
// packages/ui → ../../.. = one/ ; the PLAN evidence dir must not live in the repo tree.
const EVIDENCE_DIR = path.resolve(process.cwd(), "../../../.local/evidence/plan-0630");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

interface ParticipantView {
    participantId: string;
    principalKind: "HUMAN" | "AGENT";
    principalId: string;
    displayName?: string;
    role: "PRIMARY" | "MEMBER" | "GUARD";
    disableAt?: string | null;
    disabledAt?: string | null;
}

async function listParticipants(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
): Promise<{ participants: ParticipantView[]; capabilities: Record<string, boolean> }> {
    const response = await request.get(
        `${CP_URL}/api/v1/sessions/${encodeURIComponent(sessionId)}/participants`,
        { headers },
    );
    expect(
        response.ok(),
        `participants ${response.status()}: ${await response.text()}`,
    ).toBeTruthy();
    return (await response.json()) as {
        participants: ParticipantView[];
        capabilities: Record<string, boolean>;
    };
}

/**
 * PLAN-0439 / BL-148: chat admission needs an explicit Session binding (a READY
 * chat connection at the pinned revision). The real key is taken from the
 * runner-provided env on the node side only — it never enters the page context.
 */
async function ensureOpenAiCompatConnection(
    request: APIRequestContext,
    headers: Record<string, string>,
    modelName: string,
): Promise<{ id: string; providerId: string; revision: number }> {
    const apiKey = process.env.XIHE_E2E_REAL_XIAOMI_KEY;
    expect(apiKey, "real provider key (XIHE_E2E_REAL_XIAOMI_KEY) is required").toBeTruthy();
    const list = await request.get(`${CP_URL}/api/v1/provider-connections`, { headers });
    expect(list.ok(), await list.text()).toBeTruthy();
    type ConnectionView = {
        id: string;
        providerId: string;
        revision: number;
        enabled: boolean;
        status: string;
        operation?: string;
        manualModels?: string[];
    };
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
            connectionKey: "plan0630-to-cc",
            label: "PLAN-0630 to/cc walkthrough",
            scope: "USER",
            modelDiscovery: "manual",
            manualModels: [modelName],
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
    expect(connection.status, "the real MiMo connection must verify READY").toBe("READY");
    return connection;
}

test.describe("@host PLAN-0630 T5b.4 real to/cc walkthrough", () => {
    test.describe.configure({ mode: "serial", retries: 0 });

    test("to=A answers, cc=B is notified without a run, @B answers passively", async ({
        page,
        request,
    }) => {
        test.skip(
            !process.env.XIHE_E2E_REAL_XIAOMI_KEY,
            "requires a real provider key (XIHE_E2E_REAL_XIAOMI_KEY)",
        );
        test.skip(
            REAL_ROUTE !== "openai-compat",
            "requires XIHE_E2E_REAL_ROUTE=openai-compat (runner imports the OpenAI-compatible provider config)",
        );
        test.setTimeout(600_000);
        mkdirSync(EVIDENCE_DIR, { recursive: true });

        const sessionRuns: Array<{ runId: string; status: string; principalId: string | null }> =
            [];
        const chatSubmissions: Array<{
            cc?: string[];
            asParticipantId?: string | null;
            body: string;
        }> = [];
        const browserErrors: string[] = [];
        page.on("pageerror", (error) => browserErrors.push(error.message));
        page.on("request", (outgoing) => {
            if (outgoing.method() !== "POST") return;
            if (new URL(outgoing.url()).pathname !== "/api/v1/chat") return;
            try {
                const body = outgoing.postDataJSON() as {
                    cc?: string[];
                    asParticipantId?: string | null;
                };
                chatSubmissions.push({ ...body, body: outgoing.postData() ?? "" });
            } catch {
                // A non-JSON body never reaches the chat controller in this path.
            }
        });

        const ctx = await registerJourneyUser(request, "plan0630-to-cc"),
            wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await ensureAgentWorkspaceBinding(wsId);
        await waitForControlPlaneAgentReady(request, headers);

        const meResponse = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
        expect(meResponse.ok(), await meResponse.text()).toBeTruthy();
        const userId = requireUuid(((await meResponse.json()) as { id: string }).id, "userId");
        // Session creation requires a bound agent principal; principal creation and binding
        // are separately authorized (CREATE_ACCOUNT / MANAGE_WORKSPACE_AGENTS).
        seedUserGrant(userId, wsId, [{ actionClass: "write", resource: "*" }]);

        const connection = await ensureOpenAiCompatConnection(request, headers, MODEL_ID);

        // One template + two WORKSPACE principals: A (PRIMARY) and B (cc member).
        const roleId = randomUUID(),
            templateId = randomUUID();
        const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers,
            data: {
                roles: JSON.stringify([
                    {
                        id: roleId,
                        name: "PLAN0630 ToCc Role",
                        permissions: [{ actionClass: "write", resource: "*" }],
                    },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "PLAN0630 ToCc Agent",
                        description: "to/cc walkthrough fixture",
                        systemPrompt:
                            "You are a concise assistant. When the user asks for a marker, reply with exactly that marker and nothing else.",
                        toolMode: "none",
                        provider: "openai",
                        model: MODEL_ID,
                        roleId,
                    },
                ]),
            },
        });
        expect(templateWrite.status(), await templateWrite.text()).toBe(200);

        async function createBoundPrincipal(name: string): Promise<string> {
            const created = await request.post(`${CP_URL}/api/v1/agent-principals`, {
                headers,
                data: { scope: "WORKSPACE", name, templateId },
            });
            expect(created.status(), await created.text()).toBe(201);
            const principalId = requireUuid(
                ((await created.json()) as { principalId: string }).principalId,
                `principal ${name}`,
            );
            const bound = await request.put(
                `${CP_URL}/api/v1/workspaces/${wsId}/agents/${principalId}`,
                { headers, data: { permissions: [{ actionClass: "write", resource: "*" }] } },
            );
            expect(bound.status(), await bound.text()).toBe(200);
            return principalId;
        }

        const principalA = await createBoundPrincipal("PLAN0630 Agent A"),
            principalB = await createBoundPrincipal("PLAN0630 Agent B");

        const sessionResponse = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers,
            data: { title: "PLAN-0630 to/cc walkthrough", agentPrincipalId: principalA },
        });
        expect(sessionResponse.status(), await sessionResponse.text()).toBe(201);
        const sessionId = requireUuid(
            ((await sessionResponse.json()) as { id: string }).id,
            "sessionId",
        );
        const bound = await request.patch(`${CP_URL}/api/v1/sessions/${sessionId}`, {
            headers,
            data: {
                providerConnectionId: connection.id,
                modelProvider: connection.providerId,
                modelName: MODEL_ID,
                connectionRevision: connection.revision,
            },
        });
        expect(bound.ok(), `session bind ${bound.status()}: ${await bound.text()}`).toBeTruthy();
        const branchId = await getRootBranchId(request, sessionId, headers);

        // A is the PRIMARY participant created with the session; B is added as a MEMBER
        // (defaults: wake=MENTION, respond=WHEN_MENTIONED).
        const createdB = await request.post(`${CP_URL}/api/v1/sessions/${sessionId}/participants`, {
            headers,
            data: { principalKind: "AGENT", principalId: principalB },
        });
        expect(createdB.status(), `participant B ${await createdB.text()}`).toBe(201);
        const participantBId = requireUuid(
            ((await createdB.json()) as { participantId: string }).participantId,
            "participantBId",
        );

        const participantViews = await listParticipants(request, headers, sessionId);
        const participantA = participantViews.participants.find(
            (item) => item.principalId === principalA && item.role === "PRIMARY",
        );
        expect(participantA, "session A must be the PRIMARY participant").toBeTruthy();
        const participantAId = requireUuid(participantA!.participantId, "participantAId");
        expect(participantViews.capabilities.speakAs, "the owner may speak as a participant").toBe(
            true,
        );
        const displayA = participantA!.displayName ?? "PLAN0630 Agent A";
        const participantB = participantViews.participants.find(
            (item) => item.participantId === participantBId,
        );
        expect(participantB?.role, "B is a MEMBER participant").toBe("MEMBER");
        const displayB = participantB!.displayName ?? "PLAN0630 Agent B";

        seedPage(page, ctx);
        await page.goto(workspaceChatPath(wsId, sessionId), { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });

        // ── Step 1: to/cc bar initial state (to = A PRIMARY, cc empty, then add B) ──
        const toSelect = page.getByTestId("speak-as-select");
        await expect(toSelect).toBeVisible({ timeout: 30_000 });
        await expect(toSelect, "to defaults to the PRIMARY participant A").toHaveValue(
            participantAId,
            { timeout: 30_000 },
        );
        const ccBar = page.getByTestId("cc-bar");
        await expect(ccBar).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId("cc-chip")).toHaveCount(0);
        await page.getByTestId("cc-add-select").selectOption(participantBId);
        const ccChip = page.getByTestId("cc-chip").filter({ hasText: displayB });
        await expect(ccChip).toBeVisible();
        await expect(page.getByTestId("cc-chip")).toHaveCount(1);
        const step1Shot = path.join(EVIDENCE_DIR, "t5b.4-step1-to-cc-initial.png");
        await page.screenshot({ scale: "css", path: step1Shot, fullPage: false });

        // ── Step 2: send with to=A, cc=B → A answers, B is notified but never runs ──
        const markerA = `T5B4-TO-A-${Date.now().toString(36)}`;
        const input = page.getByTestId("chat-input"),
            send = page.getByTestId("chat-send-button");
        const submissionsBefore = chatSubmissions.length;
        await input.click();
        await input.fill(`只回复这个标记，不要输出任何其他内容：${markerA}`);
        await expect(send).toBeEnabled({ timeout: 20_000 });
        await send.click();
        await expect
            .poll(() => chatSubmissions.length, { timeout: 30_000 })
            .toBeGreaterThan(submissionsBefore);
        const firstSubmission = chatSubmissions.at(-1)!;
        expect(firstSubmission.cc ?? [], "the POST body carries B in cc").toContain(participantBId);
        expect(firstSubmission.asParticipantId, "the POST body carries to=A").toBe(participantAId);

        await expect
            .poll(
                () =>
                    scalar(
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${sessionId}'::uuid AND status IN ('succeeded','failed','partial','cancelled','ambiguous')`,
                    ),
                { timeout: 240_000, intervals: [2_000, 3_000] },
            )
            .toBeGreaterThan(0);
        // A is the responder of the first run (chat_runs.agent_principal_id, R1 run-level responder).
        await expect
            .poll(
                () =>
                    scalar(
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${sessionId}'::uuid AND agent_principal_id = '${principalA}'::uuid AND status = 'succeeded'`,
                    ),
                { timeout: 240_000, intervals: [2_000, 3_000] },
            )
            .toBeGreaterThan(0);
        const responderA = page
            .locator('[data-testid="message-responder"]')
            .filter({ hasText: displayA });
        await expect(responderA.last(), "A's reply is attributed to A").toBeVisible({
            timeout: 180_000,
        });
        const assistantTextA = await page
            .locator('[data-slot="message"][data-align="start"]')
            .last()
            .innerText();
        expect(assistantTextA, "A's answer carries the requested marker").toContain(markerA);

        // cc observer: durable notify + no Run of its own.
        const notifyCount = scalar(
            `SELECT count(*) FROM context_events WHERE session_id = '${sessionId}'::uuid AND event_type = 'wake_dispatch' AND payload->>'participantId' = '${participantBId}' AND payload->>'outcome' = 'notify' AND payload->>'triggerSource' = 'cc'`,
        );
        expect(notifyCount, "B receives the cc notify (wake_dispatch outcome=notify)").toBe(1);
        const mentionCountB = scalar(
            `SELECT COALESCE(mention_count, 0) FROM session_participant_cursors WHERE participant_id = '${participantBId}'::uuid`,
        );
        expect(mentionCountB, "the cc notify advances B's mention_count cursor").toBe(1);
        expect(
            scalar(
                `SELECT count(*) FROM chat_runs WHERE session_id = '${sessionId}'::uuid AND agent_principal_id = '${principalB}'::uuid`,
            ),
            "a cc observer must not get a Run of its own",
        ).toBe(0);
        await expect(
            page
                .locator('[data-testid="message-responder"]')
                .filter({ hasText: displayB })
                .filter({ hasText: markerA }),
        ).toHaveCount(0);

        const step2Shot = path.join(EVIDENCE_DIR, "t5b.4-step2-a-responded.png");
        await page.screenshot({ scale: "css", path: step2Shot, fullPage: false });

        // ── Step 3: @B → B answers passively (to stays A) ──
        const markerB = `T5B4-AT-B-${Date.now().toString(36)}`;
        await expect(toSelect, "to is still A before the mention").toHaveValue(participantAId);
        const submissionsBeforeMention = chatSubmissions.length;
        await input.click();
        await input.fill(`@${displayB} 只回复这个标记，不要输出任何其他内容：${markerB}`);
        // PLAN-0630 T5b.2: the mention lands in the cc chips automatically.
        await expect(
            page.getByTestId("cc-chip").filter({ hasText: displayB }),
            "the @mention auto-adds B to the cc chips",
        ).toBeVisible();
        await expect(send).toBeEnabled({ timeout: 20_000 });
        await send.click();
        await expect
            .poll(() => chatSubmissions.length, { timeout: 30_000 })
            .toBeGreaterThan(submissionsBeforeMention);
        const mentionSubmission = chatSubmissions.at(-1)!;
        expect(mentionSubmission.cc ?? [], "the mention submission still cc's B").toContain(
            participantBId,
        );

        await expect
            .poll(
                () =>
                    scalar(
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${sessionId}'::uuid AND agent_principal_id = '${principalB}'::uuid AND status = 'succeeded'`,
                    ),
                { timeout: 240_000, intervals: [2_000, 3_000] },
            )
            .toBeGreaterThan(0);
        const responderB = page
            .locator('[data-testid="message-responder"]')
            .filter({ hasText: displayB });
        await expect(responderB.last(), "B answers the @mention").toBeVisible({
            timeout: 180_000,
        });
        const bMessages = await page
            .locator('[data-testid="message-item"]')
            .filter({ hasText: markerB })
            .allInnerTexts();
        expect(
            bMessages.some((text) => text.includes(displayB)),
            `B's own reply carries the marker and B's name: ${JSON.stringify(bMessages)}`,
        ).toBe(true);
        const step3Shot = path.join(EVIDENCE_DIR, "t5b.4-step3-b-mention-response.png");
        await page.screenshot({ scale: "css", path: step3Shot, fullPage: false });

        // ── Evidence: ids for every step ──
        const runs = psql(
            `SELECT id || '|' || COALESCE(agent_principal_id::text,'') || '|' || status FROM chat_runs WHERE session_id = '${sessionId}'::uuid ORDER BY created_at`,
        )
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const [runId, principalId, status] = line.split("|");
                return { runId, principalId: principalId || null, status };
            });
        for (const run of runs) sessionRuns.push(run);
        expect(sessionRuns.some((run) => run.principalId === principalA)).toBe(true);
        expect(sessionRuns.some((run) => run.principalId === principalB)).toBe(true);

        const messages = await request.get(
            `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${branchId}`,
            { headers },
        );
        expect(messages.ok(), await messages.text()).toBeTruthy();
        const assistantMarkers = (
            (await messages.json()) as Array<{
                role?: string;
                content?: string;
                participantId?: string;
            }>
        ).filter((message) => message.role === "ASSISTANT");
        expect(
            assistantMarkers.some((message) => message.content?.includes(markerA)),
            "the durable message list carries A's answer",
        ).toBe(true);
        expect(
            assistantMarkers.some((message) => message.content?.includes(markerB)),
            "the durable message list carries B's answer",
        ).toBe(true);

        const evidence = {
            plan: "PLAN-0630",
            task: "T5b.4",
            route: REAL_ROUTE,
            model: MODEL_ID,
            workspaceId: wsId,
            sessionId,
            branchId,
            participants: {
                a: { principalId: principalA, participantId: participantAId, role: "PRIMARY" },
                b: { principalId: principalB, participantId: participantBId, role: "MEMBER" },
            },
            runs,
            ccNotify: { participantId: participantBId, notifyCount, mentionCountB },
            submissions: chatSubmissions.map((item) => ({
                cc: item.cc ?? [],
                asParticipantId: item.asParticipantId ?? null,
            })),
            markers: { a: markerA, b: markerB },
            screenshots: [step1Shot, step2Shot, step3Shot],
            browserErrors,
            observedAt: new Date().toISOString(),
        };
        writeFileSync(
            path.join(EVIDENCE_DIR, "t5b.4-to-cc-observed.json"),
            JSON.stringify(evidence, null, 2),
        );
        await test.info().attach("t5b.4-to-cc-observed.json", {
            body: JSON.stringify(evidence, null, 2),
            contentType: "application/json",
        });

        expect(browserErrors, "no page errors during the walkthrough").toEqual([]);
    });
});
