import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    registerJourneyUser,
    seedPage,
    waitForControlPlaneAgentReady,
} from "./helpers/journey";
import { seedUserGrantPermissions } from "./helpers/user-grants";
import { workspaceChatPath } from "../../src/lib/routes";

/**
 * PLAN-0630 T5.9 — headed real-stack walkthrough (V14):
 *   real agent calls `spawn_agent` → the child session appears with a PRIMARY participant →
 *   the child session is interactive → a budget refusal is visible in the UI (not silent).
 *
 * Evidence: 4 screenshots + the session/run ids of every step under
 * `one/.local/evidence/plan-0630/` (host-e2e §6 — never inside the worktree), plus the
 * refusal text asserted from the rendered DOM.
 */

const REAL_ROUTE = process.env.XIHE_E2E_REAL_ROUTE ?? "native";
const MODEL_ID = process.env.XIHE_E2E_REAL_OPENAI_MODEL ?? "mimo-v2.6-flash";
const REAL_BASE = process.env.XIHE_E2E_REAL_OPENAI_BASE ?? "https://api.xiaomimimo.com/v1";
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

/** Chat sends is admitted only while a run is not already in flight (409 CHAT_IN_PROGRESS). */
async function waitForIdleSession(
    request: APIRequestContext,
    headers: Record<string, string>,
    sessionId: string,
): Promise<void> {
    await expect
        .poll(
            async () => {
                const res = await request.get(
                    `${CP_URL}/api/v1/chat/sessions/${sessionId}/runs?page=0&size=5`,
                    { headers },
                );
                if (!res.ok()) return "unavailable";
                const body = (await res.json()) as { runs?: Array<{ status?: string }> };
                const active = (body.runs ?? []).filter(
                    (run) =>
                        run.status !== "succeeded" &&
                        run.status !== "failed" &&
                        run.status !== "cancelled" &&
                        run.status !== "partial" &&
                        run.status !== "ambiguous",
                );
                return active.length === 0 ? "idle" : String(active[0]?.status ?? "active");
            },
            { timeout: 240_000, intervals: [1_000, 2_000, 3_000] },
        )
        .toBe("idle");
}

async function sendMessage(page: Page, text: string): Promise<void> {
    const input = page.getByTestId("chat-input"),
        send = page.getByTestId("chat-send-button");
    for (let attempt = 0; attempt < 6; attempt++) {
        await input.click().catch(() => {});
        await input.fill(text);
        if (await send.isEnabled().catch(() => false)) break;
        await page.waitForTimeout(1_000);
    }
    await expect(send).toBeEnabled({ timeout: 20_000 });
    await page
        .locator("[data-sonner-toast]")
        .first()
        .waitFor({ state: "detached", timeout: 8_000 })
        .catch(() => {});
    await send.click();
    // composer/bubble 重写后 `data-align` 移到 Bubble 原语上，`[data-slot="message"]` 不再承载它；
    // 改用每条消息行的稳定锚点 `message-item` 按文本定位（断言语义不变：发送后用户气泡出现）。
    await expect(
        page
            .getByTestId("message-item")
            .filter({ hasText: text.slice(0, 12) })
            .first(),
        "the user bubble appears after sending",
    ).toBeVisible({ timeout: 30_000 });
}

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
            // task-24 严格解析：instance 层 profile（runner 导入 `openai`/`default`/`mimo-v2.6-flash`）
            // 只在**消费用户自己**的 USER 连接里按 providerId+connectionKey 查 READY；key 不是
            // `default` 时 `POST /sessions` 直接 409 LLM_PROFILE_CONFLICT。改名只动夹具标识。
            connectionKey: "default",
            label: "PLAN-0630 delegation walkthrough",
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

test.describe("@host PLAN-0630 T5.9 real delegation walkthrough", () => {
    test.describe.configure({ mode: "serial", retries: 0 });

    test("spawn_agent child + PRIMARY + interactive child + visible budget refusal", async ({
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
        const walkthrough: Record<string, unknown> = {
            plan: "PLAN-0630",
            task: "T5.9",
            route: REAL_ROUTE,
            model: MODEL_ID,
            steps: {} as Record<string, unknown>,
        };
        const steps = walkthrough.steps as Record<string, unknown>;
        const persist = (): void => {
            writeFileSync(
                path.join(EVIDENCE_DIR, "t5.9-walkthrough-observed.json"),
                JSON.stringify({ ...walkthrough, observedAt: new Date().toISOString() }, null, 2),
            );
        };
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));

        // ── Fixture: user, workspace, real connection, workspace-tool principal ──
        const ctx = await registerJourneyUser(request, "plan0630-delegation"),
            wsId = ctx.workspaceId;
        const headers = { ...ctx.headers, "X-Workspace-Id": wsId };
        await ensureAgentWorkspaceBinding(wsId);
        await waitForControlPlaneAgentReady(request, headers);
        const meResponse = await request.get(`${CP_URL}/api/v1/auth/me`, { headers });
        expect(meResponse.ok(), await meResponse.text()).toBeTruthy();
        const userId = requireUuid(((await meResponse.json()) as { id: string }).id, "userId");
        seedUserGrantPermissions(userId, [
            // Principal creation + binding + the user's own SPAWN_AGENT ceiling.
            { actionClass: "CREATE_ACCOUNT", resource: "*" },
            { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: wsId },
            { actionClass: "SPAWN_AGENT", resource: "*" },
            // user 层 agent-templates 写入走 CREATE_TEMPLATE（AgentTemplateService.requireUserAction），
            // 旧的 `write` 原子已不再覆盖该动作；其余 real spec 同样按此播种。
            { actionClass: "CREATE_TEMPLATE", resource: "*" },
            { actionClass: "write", resource: "*" },
        ]);
        const connection = await ensureOpenAiCompatConnection(request, headers, MODEL_ID);

        const roleId = randomUUID(),
            templateId = randomUUID();
        const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers,
            data: {
                roles: JSON.stringify([
                    {
                        id: roleId,
                        name: "PLAN0630 Delegation Role",
                        permissions: [
                            { actionClass: "write", resource: "*" },
                            { actionClass: "SPAWN_AGENT", resource: "*" },
                        ],
                    },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "PLAN0630 Delegation Agent",
                        description: "CP-owned spawn_agent walkthrough fixture",
                        systemPrompt:
                            "You are an orchestration agent. When the user asks you to spawn a child agent, call the spawn_agent tool with the given prompt. Reply concisely.",
                        // host-e2e §3: spawn_agent is a CP-owned MCP tool and only exists
                        // for a workspace-tool run (toolMode=workspace).
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
            data: { scope: "WORKSPACE", name: "PLAN0630Delegator", templateId },
        });
        expect(principalResponse.status(), await principalResponse.text()).toBe(201);
        const principalId = requireUuid(
            ((await principalResponse.json()) as { principalId: string }).principalId,
            "principalId",
        );
        // 工作区 cap 的两道校验（AgentPrincipalService.setWorkspaceCap）：cap ⊆ principal 原子
        // 并集 **且** ⊆ 操作者并集。新 principal 只带 agent_default 原子，SPAWN_AGENT 必须先落
        // grants 才能通过 —— 而且是**每行单原子**（多原子行会被 RoleGrantMaterializer 判
        // malformed 并在 repair 路径撞 uq_grants_role_atom，BL-230）。instance 作用域行镜像
        // 角色授权，绑定写的是 workspace 作用域行，唯一键不冲突。配方照 0649（已验证）。
        psql(
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, scope_type, scope_id, read_state, created_at)
             SELECT gen_random_uuid(), 'user', '${userId}', 'agent_principal', '${principalId}',
                    jsonb_build_array(jsonb_build_object('actionClass', 'SPAWN_AGENT', 'resource', '*')),
                    'role', 'instance', NULL, 'read', now()
             ON CONFLICT DO NOTHING`,
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

        // 绑定会按角色绑定重置化 principal 的 grants 并丢掉临时行，所以绑定后要再补一次：
        // 会话创建时冻结的 agentPermissionsSnapshot = cap ∩ principal 原子，缺了它 spawn_agent
        // 不会出现在 tools/list（0649 attempt 6 实证）。
        psql(
            `INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source, scope_type, scope_id, read_state, created_at)
             SELECT gen_random_uuid(), 'user', '${userId}', 'agent_principal', '${principalId}',
                    jsonb_build_array(jsonb_build_object('actionClass', 'SPAWN_AGENT', 'resource', '*')),
                    'role', 'instance', NULL, 'read', now()
             ON CONFLICT DO NOTHING`,
        );
        expect(
            scalar(
                `SELECT count(*) FROM grants WHERE subject_type = 'agent_principal' AND subject_id = '${principalId}'::uuid AND permissions @> '[{"actionClass":"SPAWN_AGENT","resource":"*"}]'::jsonb`,
            ),
            "the principal carries SPAWN_AGENT before the session freezes its snapshot",
        ).toBeGreaterThan(0);

        // M1 budget: maxCount=1 → the first spawn of a run is allowed, the second is refused
        // with DELEGATION_LIMIT_EXCEEDED while the first child is still in flight.
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
            data: { title: "PLAN-0630 delegation walkthrough", agentPrincipalId: principalId },
        });
        expect(sessionResponse.status(), await sessionResponse.text()).toBe(201);
        const parentSessionId = requireUuid(
            ((await sessionResponse.json()) as { id: string }).id,
            "parentSessionId",
        );
        const boundSession = await request.patch(`${CP_URL}/api/v1/sessions/${parentSessionId}`, {
            headers,
            data: {
                providerConnectionId: connection.id,
                modelProvider: connection.providerId,
                modelName: MODEL_ID,
                connectionRevision: connection.revision,
            },
        });
        expect(boundSession.ok(), `session bind ${await boundSession.text()}`).toBeTruthy();
        // The spawn gate is an approval gate: keep the session in manual mode so the walkthrough
        // exercises the real modal instead of an auto-approval.
        psql(`UPDATE sessions SET approval_mode = 'manual' WHERE id = '${parentSessionId}'::uuid`);
        const parentBranchId = await getRootBranchId(request, parentSessionId, headers);

        walkthrough.workspaceId = wsId;
        walkthrough.principalId = principalId;
        walkthrough.parentSessionId = parentSessionId;
        walkthrough.delegationPolicy = { maxCount: 1, maxDepth: 2 };
        persist();

        seedPage(page, ctx);
        await page.goto(workspaceChatPath(wsId, parentSessionId), { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
        const modal = page.locator('[data-testid="modal-content"]');

        // ── Step 1: real agent calls spawn_agent → child session appears ──
        const childMarker = `T59-CHILD-${Date.now().toString(36)}`;
        await sendMessage(
            page,
            `请调用 spawn_agent 工具创建一个子 agent，prompt 参数填这句话：只回复标记 ${childMarker}。必须真的调用工具，不要只描述步骤。`,
        );
        await expect(modal, "the spawn gate shows the real approval modal").toBeVisible({
            timeout: 180_000,
        });
        await page.screenshot({
            scale: "css",
            path: path.join(EVIDENCE_DIR, "t5.9-step1a-spawn-approval.png"),
            fullPage: false,
        });
        await modal.locator('[data-testid="approval-approve"]').click();
        await expect(modal).toBeHidden({ timeout: 30_000 });

        let childSessionId = "";
        await expect
            .poll(
                () =>
                    psql(
                        `SELECT id FROM sessions WHERE spawned_from_session_id = '${parentSessionId}'::uuid AND kind = 'spawn' ORDER BY created_at LIMIT 1`,
                    ),
                { timeout: 240_000, intervals: [1_000, 2_000, 3_000] },
            )
            .toMatch(UUID_PATTERN);
        childSessionId = requireUuid(
            psql(
                `SELECT id FROM sessions WHERE spawned_from_session_id = '${parentSessionId}'::uuid AND kind = 'spawn' ORDER BY created_at LIMIT 1`,
            ),
            "childSessionId",
        );
        const childRunId = requireUuid(
            psql(
                `SELECT id FROM chat_runs WHERE session_id = '${childSessionId}'::uuid ORDER BY created_at LIMIT 1`,
            ),
            "childRunId",
        );
        const parentRunId = requireUuid(
            psql(
                `SELECT id FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid AND origin = 'user_submission' ORDER BY created_at DESC LIMIT 1`,
            ),
            "parentRunId",
        );
        const childName = psql(`SELECT title FROM sessions WHERE id = '${childSessionId}'::uuid`);
        await expect
            .poll(
                () =>
                    scalar(
                        `SELECT count(*) FROM audit_logs WHERE action = 'agent_spawn_created' AND resource_id = '${childSessionId}'`,
                    ),
                { timeout: 60_000, intervals: [1_000, 2_000] },
            )
            .toBe(1);
        // Live (no reload): the derived-state badge names the spawned child.
        await expect(page.getByTestId("derived-active-child")).toContainText(childName, {
            timeout: 120_000,
        });
        const step1Shot = path.join(EVIDENCE_DIR, "t5.9-step1-spawn.png");
        await page.screenshot({ scale: "css", path: step1Shot, fullPage: false });
        steps.step1 = {
            description:
                "real agent called spawn_agent; child session exists with an active-child badge",
            parentSessionId,
            parentRunId,
            childSessionId,
            childRunId,
            childSessionTitle: childName,
            screenshot: step1Shot,
        };
        persist();
        await waitForIdleSession(request, headers, parentSessionId);

        // ── Step 2: the child session carries a PRIMARY participant ──
        const childParticipants = await request.get(
            `${CP_URL}/api/v1/sessions/${childSessionId}/participants`,
            { headers },
        );
        expect(
            childParticipants.ok(),
            `child participants ${await childParticipants.text()}`,
        ).toBeTruthy();
        const childParticipantBody = (await childParticipants.json()) as {
            participants: Array<{
                participantId: string;
                principalId: string;
                role: string;
                displayName?: string;
            }>;
        };
        const primaryParticipant = childParticipantBody.participants.find(
            (item) => item.role === "PRIMARY",
        );
        expect(primaryParticipant, "the child session has a PRIMARY participant").toBeTruthy();
        const primaryParticipantId = requireUuid(
            primaryParticipant!.participantId,
            "child PRIMARY participantId",
        );

        await page.goto(workspaceChatPath(wsId, childSessionId), { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
        await page.getByTestId("workspace-toolbar-members").click();
        const primaryBadge = page.getByTestId(`participant-role-badge-${primaryParticipantId}`);
        await expect(primaryBadge, "the members dock shows the PRIMARY badge").toBeVisible({
            timeout: 60_000,
        });
        await expect(primaryBadge).toContainText(/PRIMARY|主要/i);
        const step2Shot = path.join(EVIDENCE_DIR, "t5.9-step2-child-primary.png");
        await page.screenshot({ scale: "css", path: step2Shot, fullPage: false });
        steps.step2 = {
            description: "child session opened; members dock shows the PRIMARY participant badge",
            childSessionId,
            primaryParticipantId,
            primaryPrincipalId: primaryParticipant!.principalId,
            participants: childParticipantBody.participants.map((item) => ({
                participantId: item.participantId,
                role: item.role,
                displayName: item.displayName ?? null,
            })),
            screenshot: step2Shot,
        };
        persist();

        // ── Step 3: the child session is interactive (real model answer) ──
        const interactiveMarker = `T59-INTERACTIVE-${Date.now().toString(36)}`;
        await waitForIdleSession(request, headers, childSessionId);
        await sendMessage(page, `只回复这个标记，不要输出任何其他内容：${interactiveMarker}`);
        await expect
            .poll(
                () =>
                    scalar(
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${childSessionId}'::uuid AND status = 'succeeded'`,
                    ),
                { timeout: 240_000, intervals: [2_000, 3_000] },
            )
            .toBeGreaterThan(0);
        // 同一处漂移：`data-align` 已移到 Bubble 原语，按消息行锚点 + 文本定位。
        const interactiveReply = page
            .getByTestId("message-item")
            .filter({ hasText: interactiveMarker })
            .last();
        await expect(
            interactiveReply,
            "the child answers the user in its own session",
        ).toContainText(interactiveMarker, { timeout: 180_000 });
        const interactiveRunId = requireUuid(
            psql(
                `SELECT id FROM chat_runs WHERE session_id = '${childSessionId}'::uuid ORDER BY created_at DESC LIMIT 1`,
            ),
            "interactive child runId",
        );
        const step3Shot = path.join(EVIDENCE_DIR, "t5.9-step3-child-interactive.png");
        await page.screenshot({ scale: "css", path: step3Shot, fullPage: false });
        steps.step3 = {
            description: "a message sent inside the child session got a real model answer",
            childSessionId,
            interactiveRunId,
            marker: interactiveMarker,
            screenshot: step3Shot,
        };
        persist();

        // ── Step 4: two spawn attempts in one parent run → the budget refusal ──
        await page.goto(workspaceChatPath(wsId, parentSessionId), { waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
        await waitForIdleSession(request, headers, parentSessionId);
        const spawnInvocationsBefore = scalar(
            `SELECT count(*) FROM mcp_invocations WHERE session_id = '${parentSessionId}'::uuid`,
        );
        await sendMessage(
            page,
            "请连续调用 spawn_agent 工具两次（必须两次都用工具调用）：第一次的 prompt 填「回复标记 T59-SPAWN-ONE」，第二次的 prompt 填「回复标记 T59-SPAWN-TWO」。两次调用之间不要等待，也不要只调用一次。",
        );
        // The first spawn of this run passes the gate (still needs the modal), the second is
        // refused by the delegation budget while the first child is in flight.
        const approvalSeen = await modal
            .waitFor({ state: "visible", timeout: 180_000 })
            .then(() => true)
            .catch(() => false);
        if (approvalSeen) {
            await modal.locator('[data-testid="approval-approve"]').click();
            await expect(modal).toBeHidden({ timeout: 30_000 });
        }
        await waitForIdleSession(request, headers, parentSessionId);

        const refusedRows = psql(
            `SELECT to_jsonb(a) FROM audit_logs a WHERE action = 'agent_spawn_refused' AND resource_id = '${parentSessionId}' ORDER BY created_at DESC LIMIT 1`,
        );
        const invocationDump = psql(
            `SELECT to_jsonb(i) FROM mcp_invocations i WHERE session_id = '${parentSessionId}'::uuid ORDER BY created_at`,
        );
        const spawnInvocationCount = (
            invocationDump.match(/"tool_?[nN]ame"\s*:\s*"spawn_agent"/g) ?? []
        ).length;
        const spawnInvocationsAfter = scalar(
            `SELECT count(*) FROM mcp_invocations WHERE session_id = '${parentSessionId}'::uuid`,
        );
        steps.step4 = {
            description:
                "second spawn_agent of the same run refused by the delegation budget (maxCount=1)",
            parentSessionId,
            spawnInvocationDelta: spawnInvocationsAfter - spawnInvocationsBefore,
            spawnInvocationDump: invocationDump,
            agentSpawnRefusedAudit: refusedRows || "(no agent_spawn_refused row)",
        };
        persist();
        expect(refusedRows, "CP wrote the durable agent_spawn_refused audit row").not.toBe("");
        expect(refusedRows, "the refusal reason is count_exceeded").toContain("count_exceeded");

        // V14/T5.9 criterion: the refusal must be visible in the UI, not a silent failure.
        // Expand every tool card so a persisted result/error slab is rendered, then read the
        // rendered text of the conversation.
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 });
        const cardToggles = page.getByTestId("tool-card-toggle");
        const cardCount = await cardToggles.count();
        for (let index = 0; index < cardCount; index++) {
            await cardToggles
                .nth(index)
                .click()
                .catch(() => {});
        }
        const conversationText = await page.getByTestId("message-item").allInnerTexts();
        const refusalVisible =
            conversationText.some((text) => text.includes("DELEGATION_LIMIT_EXCEEDED")) ||
            (await page
                .getByText("DELEGATION_LIMIT_EXCEEDED", { exact: false })
                .count()
                .catch(() => 0)) > 0;
        const step4Shot = path.join(EVIDENCE_DIR, "t5.9-step4-budget-refused.png");
        await page.screenshot({ scale: "css", path: step4Shot, fullPage: false });
        steps.step4 = {
            ...(steps.step4 as Record<string, unknown>),
            toolCardCount: cardCount,
            conversationText,
            refusalVisible,
            screenshot: step4Shot,
        };
        persist();
        writeFileSync(
            path.join(EVIDENCE_DIR, "t5.9-conversation-text.json"),
            JSON.stringify(conversationText, null, 2),
        );
        expect(
            refusalVisible,
            "T5.9: the budget refusal text (DELEGATION_LIMIT_EXCEEDED) must be visible in the chat UI; " +
                `rendered conversation text was: ${JSON.stringify(conversationText)}`,
        ).toBe(true);

        expect(
            scalar(
                `SELECT count(*) FROM mcp_invocations WHERE session_id = '${parentSessionId}'::uuid`,
            ),
        ).toBeGreaterThanOrEqual(spawnInvocationsBefore + 2);
        expect(spawnInvocationCount).toBeGreaterThanOrEqual(2);
        expect(parentBranchId).toMatch(UUID_PATTERN);
        expect(pageErrors, "no page errors during the walkthrough").toEqual([]);
    });
});
