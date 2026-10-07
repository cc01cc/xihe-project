import { execFileSync } from "node:child_process";
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

// PLAN-0372 (BL-28) decision #B: real-lane workspace tool round-trip over the
// OpenAI-compatible MiMo connection. The runner imports the OpenAI-compatible
// provider config (same MiMo endpoint + the same real key) and hands the Agent
// `XIHE_OPENAI_API_KEY` only when `XIHE_E2E_REAL_ROUTE=openai-compat`; every
// other invocation skips this case, so no other spec is affected.
const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
const MODEL_ID = process.env.XIHE_E2E_REAL_OPENAI_MODEL ?? "mimo-v2.5";
// The isolated host root is derived from the run id (e2e-host.mjs `hostRoot`);
// XIHE_WORKSPACE_HOST_ROOT is only injected into the runtime process.
const HOST_ROOT =
    process.env.XIHE_WORKSPACE_HOST_ROOT ??
    (process.env.XIHE_E2E_RUN_ID
        ? path.resolve(process.cwd(), "../../.tmp/e2e-host", process.env.XIHE_E2E_RUN_ID)
        : path.resolve(process.cwd(), "../../.xihe-workspaces"));
const EVIDENCE_DIR = evidenceDir("plan-0372-real-compat");

// Fresh journey users carry no grants; the template/principal/binding writes
// below need them (same fixture as session-branch/approval specs).
function seedUserGrant(userId: string, workspaceId: string) {
    const container = process.env.XIHE_E2E_PG_CONTAINER;
    const database = process.env.XIHE_E2E_PG_DATABASE;
    const dbUser = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !dbUser) {
        throw new Error(
            "isolated PostgreSQL fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    const permissions = JSON.stringify([
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "CREATE_TEMPLATE", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
        { actionClass: "write", resource: "*" },
    ]).replaceAll("'", "''");
    execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        [
            "exec",
            container,
            "psql",
            "-X",
            "-A",
            "-t",
            "-U",
            dbUser,
            "-d",
            database,
            "-c",
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, read_state) ` +
                `VALUES (gen_random_uuid(), 'user', '${userId}'::uuid, 'user', '${userId}'::uuid, ` +
                `'${permissions}'::jsonb, 'direct', 'read')`,
        ],
        { encoding: "utf8", timeout: 15_000, windowsHide: true },
    );
}

test.describe("@host PLAN-0372 real lane — OpenAI-compatible tool round-trip", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(300000);

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
        const ctx = await registerJourneyUser(request, "real-compat");
        const wsId = ctx.workspaceId;
        const headers = ctx.headers;
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
        seedUserGrant(userId, wsId);
        const setupHeaders = { ...headers, "X-Workspace-Id": wsId };
        const roleId = randomUUID();
        const templateId = randomUUID();
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
                        name: "Real Compat Agent",
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
            data: { name: "Real Compat Agent", templateId },
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

        // Pin the canonical pair to the OpenAI-compatible route (in this mode the
        // catalog lists the MiMo models under provider `openai`).
        const trigger = page.getByTestId("model-popover-trigger");
        await expect(trigger).toBeVisible();
        await trigger.click();
        const modelSearch = page.getByTestId("model-popover-search");
        await modelSearch.fill(MODEL_ID);
        await expect(page.getByTestId(`model-item-openai/${MODEL_ID}`)).toBeVisible({
            timeout: 15000,
        });
        await modelSearch.press("Enter");

        // The session was created above; use it directly instead of racing the
        // session list (2026-10-02 review: the poll could pick another session).
        const sessionId = seededSessionId;
        const branchId = await getRootBranchId(request, sessionId, headers);
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
                .waitFor({ state: "visible", timeout: 90000 })
                .then(() => true)
                .catch(() => false);
            if (approved) {
                await page.screenshot({
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
                        timeout: approved ? 60000 : 15000,
                    })
                    .toContain(content);
                landed = true;
            } catch (error) {
                if (attempt === 2) throw error;
                // Wait for the first run to settle before the nudge (CHAT_IN_PROGRESS).
                await expect
                    .poll(
                        async () => {
                            const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, {
                                headers,
                            });
                            const body = (await res.json()) as {
                                operations?: Array<{ status?: string }>;
                            };
                            return body.operations?.[0]?.status ?? "unknown";
                        },
                        { timeout: 120000, intervals: [2_000] },
                    )
                    .toBe("completed");
            }
        }

        // Round-trip facts are the success criteria: the file landed, the ledger
        // recorded a completed write_file item, and the assistant reply was
        // persisted. The durable ROOT status is recorded (`b-observed.json`) for
        // the PLAN evidence: 2026-09-19 real-run observation shows the run and
        // operation parking at awaiting_approval/waiting_for_approval after a
        // successful post-approval completion (CP lifecycle gap, out of this
        // harness-only PLAN's scope — see evidence/m2-real-ab.md).
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
                { timeout: 60000, intervals: [2_000] },
            )
            .toBeGreaterThan(0);

        const opsRes = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers });
        expect(opsRes.ok(), `operations list ${opsRes.status()}`).toBeTruthy();
        const op = (
            (await opsRes.json()) as { operations?: Array<{ id?: string; status?: string }> }
        ).operations?.[0];
        expect(op?.id, "operation id resolvable").toBeTruthy();
        const traceRes = await request.get(`${CP_URL}/api/v1/operations/${op?.id}`, { headers });
        const trace = (await traceRes.json()) as {
            items?: Array<{ toolName?: string; status?: string }>;
        };
        // The approval gate creates several ledger rows for the same tool call
        // (agent attempt + gate + approved re-dispatch); the completed one is the
        // real execution — assert at least one reached `completed`.
        const writeFileItems = (trace.items ?? []).filter((item) => item.toolName === "write_file");
        expect(
            writeFileItems.some((item) => item.status === "completed"),
            `write_file must complete through the real tool chain (statuses: ${writeFileItems
                .map((item) => item.status)
                .join(",")})`,
        ).toBe(true);
        writeFileSync(
            path.join(EVIDENCE_DIR, "b-observed.json"),
            JSON.stringify(
                {
                    sessionId,
                    runId: assistant?.runId ?? null,
                    runStatus: assistant?.runStatus ?? null,
                    terminalOutcome: assistant?.terminalOutcome ?? null,
                    errorCode: assistant?.errorCode ?? null,
                    operationId: op?.id ?? null,
                    operationStatus: op?.status ?? null,
                    writeFileItemStatuses: writeFileItems.map((item) => item.status ?? null),
                    assistantChars: (assistant?.content ?? "").length,
                    observedAt: new Date().toISOString(),
                },
                null,
                2,
            ),
        );
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "b-roundtrip.png"),
            fullPage: false,
        });
    });
});
