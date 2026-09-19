import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
    CP_URL,
    awaitLastOperationCompleted,
    ensureAgentWorkspaceBinding,
    ensureChatReady,
    evidenceDir,
    registerJourneyUser,
    seedPage,
    sendChat,
} from "./helpers/journey";

const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
// e2e-host passes XIHE_WORKSPACE_HOST_ROOT to the runtime process but not to
// the Playwright process; the isolated root is derived from the run id
// (e2e-host.mjs `hostRoot`, see journey-c.spec.ts).
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ??
    (process.env.XIHE_E2E_RUN_ID
        ? path.resolve(process.cwd(), "../../.tmp/e2e-host", process.env.XIHE_E2E_RUN_ID)
        : path.resolve(process.cwd(), "../../.xihe-workspaces"));
const EVIDENCE_DIR = evidenceDir("journey-d");

// PLAN-294 Journey D spec: context pipeline + auto-compaction.
//   D1 — multi-turn memory: turn-2 LLM response must reference turn-1's marker
//   (M2/M3 tests will extend this spec with compaction assertions.)
// D1 needs the deterministic fake LLM marker mode:
//   XIHE_E2E_LLM_MODE=history-marker mise run test:e2e-host -- e2e/real/journey-d.spec.ts
// The fake LLM scans the full messages array it receives and echoes:
//   XIHE-HIST-SEEN: <prior markers> | XIHE-HIST-CURRENT: <current marker>
// M0 intentionally pins the CURRENT broken behavior: turn-2 sees no history,
// so D1 FAILS with "no prior markers" until M1 wires the pipeline.
test.describe("@host Journey D — context pipeline", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(240000);

    // Agent keeps ONE MCP workspace binding per process — share a single
    // registered user/workspace across the describe (journey-a/b/c pattern).
    let sharedAuth: string;
    let sharedWs: string;
    let sharedHeaders: Record<string, string>;

    test.beforeAll(async ({ request }) => {
        const ctx = await registerJourneyUser(request, "journey-d");
        sharedAuth = ctx.authToken;
        sharedWs = ctx.workspaceId;
        sharedHeaders = ctx.headers;
    });

    test("D1: turn-2 LLM sees turn-1 marker (multi-turn memory reaches the provider)", async ({
        page,
    }) => {
        test.skip(
            LLM_MODE !== "history-marker",
            "requires XIHE_E2E_LLM_MODE=history-marker fake LLM marker mode",
        );
        // PLAN-0369: single-binding Agent — rebind before the workspace chat.
        await ensureAgentWorkspaceBinding(sharedWs);
        // The fake-marker envelope assertions only hold against the fixture; a
        // real-provider smoke run (D1-real) must not execute them.
        test.skip(
            !!process.env.XIHE_E2E_REAL_XIAOMI_KEY,
            "fixture marker envelope is fixture-only; real runs use D1-real",
        );
        const authToken = sharedAuth;
        const wsId = sharedWs;
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const marker1 = `T1${Date.now().toString(36).toUpperCase()}`;
        const marker2 = `T2${Date.now().toString(36).toUpperCase()}`;

        seedPage(page, { authToken, workspaceId: wsId, headers: sharedHeaders });
        // A brand-new user may land on the empty "no active session" state —
        // 新建对话 is the real user path out of it (auto-session creation can
        // race CP readiness on cold starts).
        await page.goto("/workspace/" + wsId, { waitUntil: "load" });
        const chatInput = page.locator('[data-testid="chat-input"]');
        if (!(await chatInput.isVisible({ timeout: 10000 }).catch(() => false))) {
            const newChat = page.getByRole("button", { name: "新建对话" }).first();
            if (await newChat.isVisible().catch(() => false)) {
                await newChat.click();
            } else {
                await page.reload({ waitUntil: "load" });
            }
        }
        await expect(chatInput, "chat input visible on workspace page").toBeVisible({
            timeout: 30000,
        });
        const lastAssistant = page.locator('[data-slot="message"][data-align="start"]').last();

        // Turn 1: plant the marker. The reply echoes XIHE-HIST-SEEN: none (first
        // turn — no history yet, this half holds both before and after M1).
        await sendChat(page, `Remember marker XIHE-E2E-HIST ${marker1} for later.`);
        await expect(
            lastAssistant,
            "turn-1 reply echoes the fake LLM marker envelope",
        ).toContainText("XIHE-HIST-SEEN: none", { timeout: 120000 });
        await page.screenshot({ path: path.join(EVIDENCE_DIR, "d1-turn1.png"), fullPage: false });

        await awaitLastOperationCompleted(page.request, sharedHeaders);

        // Turn 2: plant a second marker. The provider receives the messages array
        // — if the pipeline is intact, turn-1's marker MUST be among them.
        await sendChat(
            page,
            `Now check: marker XIHE-E2E-HIST ${marker2}. What markers do you see?`,
        );
        const reply = lastAssistant;
        await expect(reply, "turn-2 reply echoes the fake LLM marker envelope").toContainText(
            `XIHE-HIST-CURRENT: ${marker2}`,
            { timeout: 120000 },
        );

        // THE PIN: turn-1's marker must appear in the provider-visible history.
        await expect(
            reply,
            "turn-2 request must carry turn-1 marker (conversation memory)",
        ).toContainText(`XIHE-HIST-SEEN: ${marker1}`, { timeout: 30000 });
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "d1-turn2-memory.png"),
            fullPage: false,
        });
    });

    test("D1-real: native route rejects tools explicitly — no silent route switch (boundary)", async ({
        page,
        request,
    }) => {
        test.skip(
            !process.env.XIHE_E2E_REAL_XIAOMI_KEY,
            "requires a real provider key (XIHE_E2E_REAL_XIAOMI_KEY)",
        );
        // PLAN-0372 decision #A: this boundary case pins the native `xiaomi` route
        // under a workspace (tool-enabled) chat. PLAN-0364 M3 removed the silent
        // switch to an OpenAI-compatible route, so the run MUST fail with the
        // explicit `LLM_TOOL_ROUTE_UNSUPPORTED` mapping (PLAN-0364 M3 behavior).
        test.skip(
            REAL_ROUTE !== "native",
            "native-route boundary case only runs with XIHE_E2E_REAL_ROUTE=native",
        );
        // PLAN-0372 (BL-28): the real lane restarts the Agent through the same
        // contract as mock now — rebind its single MCP workspace to this spec's
        // registered workspace before the first workspace chat.
        await ensureAgentWorkspaceBinding(sharedWs);
        const authToken = sharedAuth;
        const wsId = sharedWs;
        const headers = sharedHeaders;
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const fileName = `xh-real-boundary-${Date.now().toString(36)}.txt`;

        seedPage(page, { authToken, workspaceId: wsId, headers });
        await page.goto("/workspace/" + wsId, { waitUntil: "load" });
        await ensureChatReady(page);

        // Pin the session binding to the native route explicitly (chat-availability
        // real uses the same popover flow) so "no silent route switch" has a
        // concrete before/after: the session must stay on xiaomi/mimo-v2.5 after
        // the refusal.
        const trigger = page.getByTestId("model-popover-trigger");
        await expect(trigger).toBeVisible();
        await trigger.click();
        const modelSearch = page.getByTestId("model-popover-search");
        await modelSearch.fill("mimo-v2.5");
        await expect(page.getByTestId("model-item-xiaomi/mimo-v2.5")).toBeVisible({
            timeout: 15000,
        });
        await modelSearch.press("Enter");

        let sessionId = "";
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${CP_URL}/api/v1/sessions`, { headers });
                    if (!res.ok()) return "";
                    const body = (await res.json()) as { sessions?: Array<{ id?: string }> };
                    sessionId = body.sessions?.[0]?.id ?? "";
                    return sessionId;
                },
                { timeout: 30000 },
            )
            .not.toBe("");
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, {
                        headers,
                    });
                    if (!res.ok()) return "";
                    const body = (await res.json()) as {
                        modelProvider?: string;
                        modelName?: string;
                    };
                    return `${body.modelProvider ?? ""}/${body.modelName ?? ""}`;
                },
                { timeout: 15000 },
            )
            .toBe("xiaomi/mimo-v2.5");

        // Any workspace chat binds the MCP tool surface, so the native route's
        // refusal happens at the provider call — before any tool can run.
        await sendChat(
            page,
            `请使用 write_file 工具创建文件 ${fileName}，内容为 boundary。完成后只回复文件名。`,
        );

        // 1) The failure must surface explicitly to the user.
        await expect(
            page.getByText(/LLM_TOOL_ROUTE_UNSUPPORTED/).first(),
            "explicit route-unsupported error visible in the UI",
        ).toBeVisible({ timeout: 120000 });
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "d1-real-native-boundary.png"),
            fullPage: false,
        });

        // 2) Server-side truth: the run's operation fails with the mapped code.
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, {
                        headers,
                    });
                    const body = (await res.json()) as { operations?: Array<{ status?: string }> };
                    return body.operations?.[0]?.status ?? "unknown";
                },
                { timeout: 120000, intervals: [2_000] },
            )
            .toBe("failed");
        const opsRes = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers });
        expect(opsRes.ok(), `operations list ${opsRes.status()}`).toBeTruthy();
        const op = (
            (await opsRes.json()) as {
                operations?: Array<{ id?: string; status?: string; errorCode?: string }>;
            }
        ).operations?.[0];
        expect(op?.errorCode, "UnsupportedParamsError maps to LLM_TOOL_ROUTE_UNSUPPORTED").toBe(
            "LLM_TOOL_ROUTE_UNSUPPORTED",
        );

        // 3) No silent route switch: the canonical pair stays native xiaomi, no
        //    assistant content is produced, no write_file item completes, and the
        //    requested file never lands in the workspace host root.
        const sessRes = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}`, { headers });
        expect(sessRes.ok(), `session ${sessRes.status()}`).toBeTruthy();
        const sess = (await sessRes.json()) as { modelProvider?: string; modelName?: string };
        expect(
            `${sess.modelProvider ?? ""}/${sess.modelName ?? ""}`,
            "route binding unchanged",
        ).toBe("xiaomi/mimo-v2.5");
        const messagesRes = await request.get(`${CP_URL}/api/v1/sessions/${sessionId}/messages`, {
            headers,
        });
        const stored = messagesRes.ok() ? await messagesRes.json() : [];
        expect(
            (stored as Array<{ role?: string; content?: string }>).filter(
                (message) => message.role === "ASSISTANT" && (message.content?.length ?? 0) > 0,
            ),
            "failed run must not produce assistant content via a fallback route",
        ).toEqual([]);
        if (op?.id) {
            const traceRes = await request.get(`${CP_URL}/api/v1/operations/${op.id}`, { headers });
            const trace = (await traceRes.json()) as {
                items?: Array<{ toolName?: string; status?: string }>;
            };
            expect(
                (trace.items ?? []).some(
                    (item) => item.toolName === "write_file" && item.status === "completed",
                ),
                "no tool may execute when the route rejects tools",
            ).toBe(false);
        }
        expect(
            existsSync(path.join(HOST_ROOT, wsId, fileName)),
            "requested file must not exist after a route-level refusal",
        ).toBe(false);
    });

    test("D2: manual compaction keeps summary visible to the LLM (epoch injection)", async ({
        page,
    }) => {
        test.skip(
            LLM_MODE !== "history-marker",
            "requires XIHE_E2E_LLM_MODE=history-marker fake LLM marker mode",
        );
        // PLAN-0369: single-binding Agent — rebind before the workspace chat.
        await ensureAgentWorkspaceBinding(sharedWs);
        // The marker envelope is a fixture contract; a real model treats it as
        // prompt injection and refuses (observed with mimo, PLAN-301 M3).
        test.skip(
            !!process.env.XIHE_E2E_REAL_XIAOMI_KEY,
            "fixture marker envelope is fixture-only; real runs use D1-real",
        );
        const authToken = sharedAuth;
        const wsId = sharedWs;
        const headers = sharedHeaders;
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const markerA = `A${Date.now().toString(36).toUpperCase()}`;
        const markerB = `B${Date.now().toString(36).toUpperCase()}`;

        seedPage(page, { authToken, workspaceId: wsId, headers: sharedHeaders });
        await page.goto("/workspace/" + wsId, { waitUntil: "load" });
        const lastAssistant = page.locator('[data-slot="message"][data-align="start"]').last();

        // Turn 1: plant marker A, wait for the run to finish server-side.
        await sendChat(page, `Plant marker XIHE-E2E-HIST ${markerA} now.`);
        await expect(lastAssistant).toContainText(`XIHE-HIST-CURRENT: ${markerA}`, {
            timeout: 120000,
        });
        await awaitLastOperationCompleted(page.request, sharedHeaders);

        // Manual compaction (decision #15): user-reachable endpoint on
        // /api/v1/sessions (M3 UI entry will call the same route).
        const sessRes = await page.request.get(`${CP_URL}/api/v1/sessions`, { headers });
        expect(sessRes.ok(), `sessions list ${sessRes.status()}`).toBeTruthy();
        const body = (await sessRes.json()) as { sessions?: Array<{ id: string }> };
        const sessionId = body.sessions?.[0]?.id ?? "";
        expect(sessionId, "session id resolvable").not.toBe("");
        const comp2 = await page.request.post(`${CP_URL}/api/v1/sessions/${sessionId}/compact`, {
            headers,
            data: {},
        });
        expect(
            comp2.ok(),
            `compact must succeed: ${comp2.status()} ${await comp2.text()}`,
        ).toBeTruthy();

        // Turn 2: the pre-compaction marker must STILL reach the provider —
        // via the summary (epoch) and/or the kept-recent tail rather than raw
        // full history.
        await sendChat(page, `Now plant marker XIHE-E2E-HIST ${markerB}. What markers exist?`);
        const reply = lastAssistant;
        await expect(reply).toContainText(`XIHE-HIST-CURRENT: ${markerB}`, { timeout: 120000 });
        await expect(
            reply,
            "post-compaction turn must still see pre-compaction marker (summary + kept tail)",
        ).toContainText(markerA, { timeout: 30000 });
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "d2-post-compaction-memory.png"),
            fullPage: false,
        });
    });
});
