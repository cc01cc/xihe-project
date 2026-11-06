import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    ensureChatReady,
    evidenceDir,
    getRootBranchId,
    registerJourneyUser,
    seedPage,
    sendChat,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { bindSessionViaApi } from "./helpers/session-binding";
import { seedUserGrant } from "./helpers/user-grants";

// PLAN-0372 (BL-28) decision #B: real-lane workspace tool round-trip over the
// OpenAI-compatible MiMo connection. The runner imports the OpenAI-compatible
// provider config (same MiMo endpoint + the same real key) and hands the Agent
// `XIHE_OPENAI_API_KEY` only when `XIHE_E2E_REAL_ROUTE=openai-compat`; every
// other invocation skips this case, so no other spec is affected.
const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
const MODEL_ID = process.env.XIHE_E2E_REAL_OPENAI_MODEL ?? "mimo-v2.6-flash";
// The isolated host root is derived from the run id (e2e-host.mjs `hostRoot`);
// XIHE_WORKSPACE_HOST_ROOT is only injected into the runtime process.
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ??
    (process.env.XIHE_E2E_RUN_ID
        ? path.resolve(process.cwd(), "../../.tmp/e2e-host", process.env.XIHE_E2E_RUN_ID)
        : path.resolve(process.cwd(), "../../.xihe-workspaces"));
const EVIDENCE_DIR = evidenceDir("plan-0372-real-compat");

// 2026-11-06 (PLAN-0650 M4 V5)：真模型单轮时延会显著超过 fake lane 口径（本机实测
// mimo-v2.6-flash 一轮 ≈4m45s），原 300s 硬编 budget 直接超时。预算与派生等待一律
// env 可调（同一条 env，单一旋钮），缺省 900s；不按模型特例硬编。各阶段等待按
// 原 300s 口径的比例随 budget 缩放，单测/默认缺省（900s）下为原值的 3 倍。
const REAL_TEST_TIMEOUT_MS = (() => {
    const parsed = Number(process.env.XIHE_E2E_REAL_TEST_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed >= 60000 ? parsed : 900000;
})();
const REAL_BUDGET_SCALE = REAL_TEST_TIMEOUT_MS / 300000;
const REAL_MODAL_WAIT_MS = Math.round(90000 * REAL_BUDGET_SCALE);
const REAL_FILE_LAND_MS = Math.round(60000 * REAL_BUDGET_SCALE);
const REAL_RUN_SETTLE_MS = Math.round(120000 * REAL_BUDGET_SCALE);
const REAL_FINAL_MESSAGE_MS = Math.round(60000 * REAL_BUDGET_SCALE);

test.describe("@host PLAN-0372 real lane — OpenAI-compatible tool round-trip", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(REAL_TEST_TIMEOUT_MS);

    test("B: write_file round-trip over the OpenAI-compatible MiMo connection", async ({
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
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        const ctx = await registerJourneyUser(request, "real-compat"),
            wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        // PLAN-0372 (BL-28): per-run workspace binding; the restart contract in
        // this mode carries XIHE_OPENAI_API_KEY (same real key, never printed).
        await ensureAgentWorkspaceBinding(wsId);
        // The rebind leaves CP's cached agent readiness stale until its next
        // probe; the chat gate rejects with AGENT_UNAVAILABLE (llmReady unknown)
        // if the first send wins that race (2026-10-02 real run, 114ms miss).
        await waitForControlPlaneAgentReady(request, headers);

        // PLAN-0374 session gates: Session creation requires at least one
        // workspace-bound agent principal, so seed grants/template/principal/
        // binding and create the Session through the API (session-branch pattern).
        const meRes = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
        expect(meRes.ok(), await meRes.text()).toBeTruthy();
        const userId = ((await meRes.json()) as { id: string }).id;
        seedUserGrant(userId, wsId, [{ actionClass: "write", resource: "*" }]);
        const setupHeaders = { ...headers, "X-Workspace-Id": wsId },
            roleId = randomUUID(),
            templateId = randomUUID();
        const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers: setupHeaders,
            data: {
                roles: JSON.stringify([
                    {
                        id: roleId,
                        name: "Real Compat Role",
                        permissions: [{ actionClass: "write", resource: "*" }],
                    },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "RealCompatAgent",
                        description: "Workspace-bound fixture for the openai-compat round trip",
                        systemPrompt: "Use only the Workspace tools provided by CP.",
                        toolMode: "workspace",
                        provider: "openai",
                        model: MODEL_ID,
                        roleId,
                    },
                ]),
            },
        });
        expect(templateWrite.status(), await templateWrite.text()).toBe(200);
        const principalRes = await request.post(`${CP_URL}/api/v1/agent-principals`, {
            headers: setupHeaders,
            data: { name: "RealCompatAgent", templateId },
        });
        expect(principalRes.status(), await principalRes.text()).toBe(201);
        const principalId = ((await principalRes.json()) as { principalId: string }).principalId;
        const bindRes = await request.put(
            `${CP_URL}/api/v1/workspaces/${wsId}/agents/${principalId}`,
            {
                headers: setupHeaders,
                data: { permissions: [{ actionClass: "write", resource: "*" }] },
            },
        );
        expect(bindRes.status(), await bindRes.text()).toBe(200);
        // PLAN-0650 M4: task-24 strict resolve maps the instance-layer profile to
        // the *consuming user's own* USER+READY connectionKey='default' (no
        // cross-owner fallback). The runner seeds that connection on its admin
        // account; this spec acts as a fresh journey user, so seed our own before
        // the session POST (create is isAuthenticated(); manual discovery verifies
        // READY without a network call, and the key stays in the node-side ctx).
        const connectionRes = await request.post(`${CP_URL}/api/v1/provider-connections`, {
            headers: setupHeaders,
            data: {
                providerId: "openai",
                apiTypeId: "openai-chat-completions",
                apiTypeVersion: 1,
                apiKey: process.env.XIHE_E2E_REAL_XIAOMI_KEY,
                connectionKey: "default",
                label: "e2e real LLM (journey user)",
                scope: "USER",
                modelDiscovery: "manual",
                manualModels: [MODEL_ID],
                baseUrl: process.env.XIHE_E2E_REAL_OPENAI_BASE ?? "https://api.xiaomimimo.com/v1",
            },
        });
        expect(connectionRes.ok(), await connectionRes.text()).toBeTruthy();
        const journeyConnection = (await connectionRes.json()) as {
            id: string;
            status?: string;
        };
        if (journeyConnection.status !== "READY") {
            const verifyRes = await request.post(
                `${CP_URL}/api/v1/provider-connections/${journeyConnection.id}/verify`,
                { headers: setupHeaders },
            );
            expect(verifyRes.ok(), await verifyRes.text()).toBeTruthy();
        }
        const sessionRes = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers: setupHeaders,
            data: { title: "Real compat round trip", agentPrincipalId: principalId },
        });
        expect(sessionRes.status(), await sessionRes.text()).toBe(201);
        const seededSessionId = ((await sessionRes.json()) as { id: string }).id;

        seedPage(page, { authToken: ctx.authToken, workspaceId: wsId, headers });
        await page.goto("/workspace/" + wsId + "/chat/" + seededSessionId, {
            waitUntil: "load",
        });
        await ensureChatReady(page);

        // The session was created above; use it directly instead of racing the
        // session list (2026-10-02 review: the poll could pick another session).
        const sessionId = seededSessionId,
            branchId = await getRootBranchId(request, sessionId, headers);
        // 2026-11-04 用户裁定移除 composer 模型选择器：绑定改走产品 PATCH API
        //（in this mode the catalog lists the MiMo models under provider `openai`）。
        await bindSessionViaApi(request, CP_URL, headers, sessionId, "openai", MODEL_ID);
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
            .toBe(`openai/${MODEL_ID}`);

        const fileName = `xh-real-compat-${Date.now().toString(36)}.txt`;
        const content = `openai-compat round trip ${fileName}`;
        // The model may address the file at the workspace root or under an
        // explicit `workspace/` subfolder (2026-10-02 real run observed the
        // latter); both are in-bounds writes inside the isolated host root.
        const hostFileCandidates = [
            path.join(HOST_ROOT, wsId, fileName),
            path.join(HOST_ROOT, wsId, "workspace", fileName),
        ];
        const readHostFile = (): string => {
            for (const candidate of hostFileCandidates) {
                try {
                    const text = readFileSync(candidate, "utf8");
                    if (text !== "") return text;
                } catch {
                    // Missing candidate: keep scanning the remaining layout.
                }
            }
            return "";
        };
        const modal = page.locator('[data-testid="modal-content"]');

        // The real model may answer with prose instead of calling the tool; one
        // deterministic nudge keeps the case trustworthy without faking the call.
        let landed = false;
        for (let attempt = 1; attempt <= 2 && !landed; attempt += 1) {
            await sendChat(
                page,
                attempt === 1
                    ? `请调用 write_file 工具在当前工作区创建文件 ${fileName}，内容为「${content}」。完成后只回复文件名。`
                    : `必须实际调用 write_file 工具创建文件 ${fileName}（内容「${content}」），不要只描述步骤。`,
            );
            const approved = await modal
                .waitFor({ state: "visible", timeout: REAL_MODAL_WAIT_MS })
                .then(() => true)
                .catch(() => false);
            if (approved) {
                await page.screenshot({
                    scale: "css",
                    path: path.join(EVIDENCE_DIR, `b-approval-attempt${attempt}.png`),
                    fullPage: false,
                });
                await modal.locator('[data-testid="approval-approve"]').click();
                await expect(modal).toBeHidden({ timeout: 20000 });
            }
            try {
                await expect
                    .poll(async () => readHostFile(), {
                        message: `expected ${fileName} under ${path.join(HOST_ROOT, wsId)} to contain the requested content`,
                        timeout: approved ? REAL_FILE_LAND_MS : 15000,
                    })
                    .toContain(content);
                landed = true;
            } catch (error) {
                if (attempt === 2) throw error;
                // Wait for the first run to settle before the nudge (CHAT_IN_PROGRESS).
                await expect
                    .poll(
                        async () => {
                            const res = await request.get(
                                `${CP_URL}/api/v1/chat/sessions/${sessionId}/runs?page=0&size=1`,
                                {
                                    headers,
                                },
                            );
                            const body = (await res.json()) as {
                                runs?: Array<{ status?: string }>;
                            };
                            return body.runs?.[0]?.status ?? "unknown";
                        },
                        { timeout: REAL_RUN_SETTLE_MS, intervals: [2_000] },
                    )
                    .toBe("succeeded");
            }
        }

        // Round-trip facts are the success criteria: the file landed, the
        // canonical MCP invocation/attempt reached success, and the assistant
        // reply plus terminal ChatRun outcome were persisted.
        const messagesRes = await request.get(
            `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${branchId}`,
            {
                headers,
            },
        );
        expect(messagesRes.ok(), `messages list ${messagesRes.status()}`).toBeTruthy();
        let assistant:
            | {
                  role?: string;
                  content?: string;
                  runId?: string;
                  runStatus?: string;
                  terminalOutcome?: string;
                  errorCode?: string | null;
              }
            | undefined;
        // The file lands when the approved tool finishes; the final assistant
        // message is persisted slightly later, so poll instead of racing it.
        await expect
            .poll(
                async () => {
                    const res = await request.get(
                        `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${branchId}`,
                        { headers },
                    );
                    if (!res.ok()) return -1;
                    const list = (await res.json()) as Array<{
                        role?: string;
                        content?: string;
                        runId?: string;
                        runStatus?: string;
                        terminalOutcome?: string;
                        errorCode?: string | null;
                    }>;
                    assistant = list.filter((message) => message.role === "ASSISTANT").slice(-1)[0];
                    return (assistant?.content ?? "").length;
                },
                { timeout: REAL_FINAL_MESSAGE_MS, intervals: [2_000] },
            )
            .toBeGreaterThan(0);

        expect(assistant?.runStatus).toBe("succeeded");
        expect(assistant?.terminalOutcome).toBe("success");

        const auditRes = await request.get(
            `${CP_URL}/api/v1/audit/entries?sessionId=${sessionId}&type=mcp_invocation&page=0&size=50`,
            { headers },
        );
        expect(auditRes.ok(), `audit entries ${auditRes.status()}`).toBeTruthy();
        const auditPage = (await auditRes.json()) as {
            entries?: Array<{ id?: string; type?: string; summary?: string; status?: string }>;
        };
        const invocation = auditPage.entries?.find(
            (entry) =>
                entry.type === "mcp_invocation" &&
                entry.summary === "write_file" &&
                entry.status === "completed",
        );
        expect(invocation?.id, "completed write_file MCP invocation is visible").toBeTruthy();

        const detailRes = await request.get(
            `${CP_URL}/api/v1/audit/entries/mcp_invocation/${invocation?.id}`,
            { headers },
        );
        expect(detailRes.ok(), `MCP invocation detail ${detailRes.status()}`).toBeTruthy();
        const detail = (await detailRes.json()) as {
            entry?: { status?: string; summary?: string };
            timeline?: Array<{ eventType?: string }>;
            attempts?: Array<{ stage?: string; status?: string }>;
        };
        expect(detail.entry).toMatchObject({ status: "completed", summary: "write_file" });
        expect(detail.timeline?.some((event) => event.eventType === "invocation.opened")).toBe(
            true,
        );
        expect(detail.attempts?.some((attempt) => attempt.status === "succeeded")).toBe(true);
        writeFileSync(
            path.join(EVIDENCE_DIR, "b-observed.json"),
            JSON.stringify(
                {
                    sessionId,
                    runId: assistant?.runId ?? null,
                    runStatus: assistant?.runStatus ?? null,
                    terminalOutcome: assistant?.terminalOutcome ?? null,
                    errorCode: assistant?.errorCode ?? null,
                    mcpInvocationId: invocation?.id ?? null,
                    mcpInvocationStatus: detail.entry?.status ?? null,
                    mcpAttemptStages: detail.attempts?.map((attempt) => attempt.stage ?? null),
                    mcpAttemptStatuses: detail.attempts?.map((attempt) => attempt.status ?? null),
                    mcpTimelineTypes: detail.timeline?.map((event) => event.eventType ?? null),
                    assistantChars: (assistant?.content ?? "").length,
                    observedAt: new Date().toISOString(),
                },
                null,
                2,
            ),
        );
        await page.screenshot({
            scale: "css",
            path: path.join(EVIDENCE_DIR, "b-roundtrip.png"),
            fullPage: false,
        });
    });
});
