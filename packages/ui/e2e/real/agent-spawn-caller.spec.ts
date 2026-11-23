// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chooseWorkspacePrincipalById, isSessionCreateRequest } from "./helpers/agent-principal";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import {
    CP_URL,
    ensureAgentWorkspaceBinding,
    getRootBranchId,
    registerJourneyUser,
    sendChat,
    seedPage,
} from "./helpers/journey";
import { workspaceSessionPath } from "../../src/lib/routes";
import { seedUserGrantPermissions } from "./helpers/user-grants";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fakeLlmUrl = new URL(CP_URL);
fakeLlmUrl.port = process.env.XIHE_FAKE_LLM_PORT ?? "13642";
const FAKE_LLM_URL = fakeLlmUrl.origin;

test.describe.configure({ mode: "serial", retries: 0 });
test.skip(
    process.env.XIHE_E2E_LLM_MODE !== "spawn_agent" ||
        Boolean(process.env.XIHE_E2E_REAL_XIAOMI_KEY),
    "requires the isolated spawn_agent fake LLM mode",
);

function requireUuid(value: string): string {
    if (!UUID_PATTERN.test(value)) throw new Error("Expected a UUID from the isolated host stack");
    return value;
}

function queryIsolatedPostgres(sql: string): string {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
    const user = process.env.XIHE_E2E_PG_USER;
    if (!container || !database || !user) {
        throw new Error(
            "isolated Postgres fixture metadata is unavailable; run through scripts/e2e-host.mjs",
        );
    }
    return execFileSync(
        process.platform === "win32" ? "docker.exe" : "docker",
        ["exec", container, "psql", "-X", "-A", "-t", "-U", user, "-d", database, "-c", sql],
        { encoding: "utf8", timeout: LONG_TIMEOUT_MS, windowsHide: true },
    ).trim();
}

function scalarCount(sql: string): number {
    const value = queryIsolatedPostgres(sql);
    if (!/^\d+$/.test(value))
        throw new Error(`Expected an isolated Postgres count, received: ${value}`);
    return Number(value);
}

/**
 * 建会话前给本 spec 的 owner 补一条 READY 的 fake-LLM USER 连接。
 *
 * `SessionProviderDefaults.resolve` 走「agent 默认模型 → 生效 llm-provider profile → 400
 * PROVIDER_REQUIRED」。真栈上实例层 profile 是 `openai/default/fake-openai`，而
 * `ConfigService.strictResolveConnection` 对 **instance 层 profile 解析到"消费方自己的 USER
 * 连接"**；runner 只为 admin 账号建了那条连接，spec 自注册的用户看不见 ⇒ 建会话 409
 * `LLM_PROFILE_CONFLICT`（spawn12d 实测）。这里按同一 providerId/connectionKey/model 给 owner
 * 建一条（写法同 `config-run-effective.spec.ts`，已存在则复用）。
 */
async function ensureFakeChatConnection(
    request: APIRequestContext,
    headers: Record<string, string>,
): Promise<void> {
    const existing = await request.get(`${CP_URL}/api/v1/provider-connections`, { headers });
    expect(existing.ok(), await existing.text()).toBeTruthy();
    const listed = (await existing.json()) as {
        connections?: Array<{ id: string; providerId?: string; status?: string }>;
    };
    const ready = (listed.connections ?? []).find(
        (item) => item.providerId === "openai" && item.status === "READY",
    );
    if (ready) return;
    const created = await request.post(`${CP_URL}/api/v1/provider-connections`, {
        headers,
        data: {
            providerId: "openai",
            apiTypeId: "openai-chat-completions",
            apiTypeVersion: 1,
            apiKey: "sk-fake-openai-key",
            connectionKey: "default",
            label: "E2E spawn fake LLM",
            scope: "USER",
            modelDiscovery: "manual",
            manualModels: ["fake-openai"],
            baseUrl: `${FAKE_LLM_URL}/openai/v1`,
        },
    });
    expect(created.status(), await created.text()).toBe(201);
    const connection = (await created.json()) as { id: string };
    const verified = await request.post(
        `${CP_URL}/api/v1/provider-connections/${connection.id}/verify`,
        { headers },
    );
    expect(verified.ok(), await verified.text()).toBeTruthy();
}

/**
 * 单次发送，不套 `sendChat` 的"用户气泡可见"成功判据。
 *
 * `sendChat` 的健壮性循环以「乐观用户气泡出现」为成功标志：本 spec 发送后 UI 立刻弹出常驻审批模态
 * （覆盖层挡住气泡判定），循环会反复重试点击、被模态拦截，直到 240s 超时——而模态里已经是本次请求
 * 的参数（spawn12e 实测：发送其实成功）。真正的判据在调用方：审批模态必须在 60s 内出现且能批准，
 * 这一条比"气泡可见"更强，因此这里只做一次可靠点击。
 */
async function sendSpawnMessage(page: Page, text: string): Promise<void> {
    const input = page.getByTestId("chat-input"),
        send = page.getByTestId("chat-send-button");
    // 不用固定 sleep（packages/ui/AGENTS.md 禁 waitForTimeout）：每次 fill 后轮询「发送按钮已可用」
    // 作为"fill 已落到 store"的就绪信号；未就绪才重填，最多 6 次，仍不就绪交给下面的显式 timeout 报错。
    for (let attempt = 0; attempt < 6; attempt++) {
        await input.click().catch(() => {});
        await input.fill(text);
        const ready = await expect
            .poll(() => send.isEnabled().catch(() => false), {
                timeout: ACTION_TIMEOUT_MS,
                intervals: [200, 400, 800],
            })
            .toBe(true)
            .then(() => true)
            .catch(() => false);
        if (ready) break;
    }
    await expect(send).toBeEnabled({ timeout: LONG_TIMEOUT_MS });
    await send.click();
}

function seedUserSpawnPermissions(userId: string, workspaceId: string): void {
    seedUserGrantPermissions(userId, [
        { actionClass: "CREATE_ACCOUNT", resource: "*" },
        { actionClass: "MANAGE_WORKSPACE_AGENTS", resource: workspaceId },
        { actionClass: "SPAWN_AGENT", resource: "*" },
    ]);
}

// BL-314 定性（2026-11-05 18:16，Lead 源码核对 + 真栈 spawn11 实证）：
// **给 agent 增加能力的合法入口是 instance 面角色绑定**，不是 workspace 角色绑定。
//   - `AgentBindingAtomPolicy.assertWithinCap` / `AgentPrincipalRoleBindingService.requireWithinCap`
//     对 instance 绑定（workspaceId == null）直接放行（"pass by construction"）；
//   - `AgentPrincipalService.validateGrantableRoles` 只查「角色存在 / 非 agent 禁授原子 /
//     调用者在实例面可授」，**不含 cap 门**，所以创建时带 roleIds 就能把能力物化到主体；
//   - workspace 角色绑定按 D-180「role=reach」只表达可达性，扩能力必 409 ROLE_BINDING_EXCEEDS_CAP。
// 因此 fixture 建一条只含 SPAWN_AGENT 的角色，创建主体时用 roleIds 绑到 instance 面，再设 workspace cap。
function createSpawnCapabilityRole(): string {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
    // 用 CTE + 顶层 SELECT 取回 id：`psql -c "INSERT … RETURNING id"` 除结果行外还会打印
    // 命令标签 `INSERT 0 1`，`requireUuid` 会因此拿到两行而失败（spawn12 实测）。顶层是
    // SELECT 时标签不再输出，`ON CONFLICT DO UPDATE` 走到更新分支也能拿回同一 id。
    const presetId = requireUuid(
        queryIsolatedPostgres(`
    WITH upserted AS (
      INSERT INTO grant_presets (id, name, display_name, description, is_system)
      VALUES (gen_random_uuid(), 'E2E_SPAWN_${suffix}', 'E2E spawn ${suffix}',
              'E2E fixture: single SPAWN_AGENT atom (BL-314)', FALSE)
      ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
      RETURNING id)
    SELECT id FROM upserted
  `),
    );
    queryIsolatedPostgres(`
    INSERT INTO grant_preset_atoms (role_id, action_class, resource_pattern)
    VALUES ('${presetId}'::uuid, 'SPAWN_AGENT', '*')
    ON CONFLICT DO NOTHING
  `);
    return presetId;
}

/**
 * setWorkspaceCap/重算之后：SPAWN_AGENT 必须仍以"单原子 + source=preset + preset_binding 背书"存在。
 *
 * 资源维度注意：`PresetGrantMaterializer` 对 `resource_pattern = '*'` 会**省略** `resource` 键，canonical
 * 形态是 `{"actionClass":"action:SPAWN_AGENT"}`（task-835 起原子带 `action:` 前缀）。所以这里不能要求
 * `resource:"*"` —— spawn12 实测该行确实存在，却因多要求一个键而被判 0 行。
 */
function assertSpawnGrantSurvivedCapPut(principalId: string, presetId: string): void {
    const rows = scalarCount(`
    SELECT count(*) FROM grants g
    WHERE g.subject_type = 'agent_principal' AND g.subject_id = '${principalId}'::uuid
      AND g.source = 'preset'
      AND g.permissions @> '[{"actionClass":"action:SPAWN_AGENT"}]'::jsonb
      AND jsonb_array_length(g.permissions) = 1
      AND EXISTS (
        SELECT 1 FROM grant_preset_bindings b
        WHERE b.subject_type = 'agent_principal' AND b.subject_id = g.subject_id
          AND b.role_id = '${presetId}'::uuid)
  `);
    if (rows !== 1) {
        throw new Error(
            "SPAWN_AGENT grant did not survive setWorkspaceCap as a bound single-atom role row",
        );
    }
}

test("@host Agent spawn uses CP logical MCP, approval retry, and child terminal link", async ({
    page,
    request,
}) => {
    const pageErrors: string[] = [],
        consoleErrors: string[] = [],
        apiFailures: string[] = [];
    const consoleErrorEvents: Array<{
        text: string;
        sourceUrl: string;
        lineNumber: number;
        observedAt: string;
    }> = [];
    const sessionRunsResponses: Array<{ status: number; url: string; body?: unknown }> = [];
    const chatSessionRequests: string[] = [];
    const browserHttpFailures: Array<{
        method: string;
        url: string;
        resourceType: string;
        status: number;
        problemCode: string | null;
        problemDetail: string | null;
        requestId: string | null;
        correlationHeaders: Record<string, string>;
        observedAt: string;
        metadataCaptureFailed?: boolean;
    }> = [];
    const httpFailureCaptures: Promise<void>[] = [],
        browserChatRequests: string[] = [];
    const browserChatSubmissions: Array<{ idempotencyKey: string | null; body: string }> = [];
    const derivedStateResponses: Array<{
        status: number;
        body: {
            sessionId?: string;
            activeChildren?: Array<{
                childSessionId: string;
                runId: string;
                name: string | null;
                status: string;
            }>;
            terminalNotices?: Array<{
                childSessionId: string;
                runId: string;
                name: string | null;
                state: string;
                terminalAt: string;
            }>;
        };
    }> = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
        if (message.type() === "error") {
            consoleErrors.push(message.text());
            const location = message.location();
            consoleErrorEvents.push({
                text: message.text(),
                sourceUrl: location.url,
                lineNumber: location.lineNumber,
                observedAt: new Date().toISOString(),
            });
        }
    });
    page.on("requestfailed", (failed) => {
        if (failed.url().startsWith(CP_URL)) apiFailures.push(`${failed.method()} ${failed.url()}`);
    });
    page.on("response", (response) => {
        if (response.status() < 400) return;
        const browserRequest = response.request(),
            safeUrl = new URL(response.url()),
            url = `${safeUrl.origin}${safeUrl.pathname}`;
        const capture = response
            .allHeaders()
            .then(async (responseHeaders) => {
                const requestHeaders = browserRequest.headers();
                let problemCode: string | null = null,
                    problemDetail: string | null = null;
                try {
                    const payload = JSON.parse(await response.text()) as {
                        code?: unknown;
                        detail?: unknown;
                    };
                    if (typeof payload.code === "string") problemCode = payload.code;
                    if (typeof payload.detail === "string") problemDetail = payload.detail;
                } catch {
                    // Non-JSON error body (e.g. a proxy HTML page) keeps both fields null.
                }
                browserHttpFailures.push({
                    method: browserRequest.method(),
                    url,
                    resourceType: browserRequest.resourceType(),
                    status: response.status(),
                    problemCode,
                    problemDetail,
                    requestId: responseHeaders["x-request-id"] ?? null,
                    correlationHeaders: Object.fromEntries(
                        [
                            "x-request-id",
                            "x-chat-run-id",
                            "x-operation-id",
                            "x-agent-session-id",
                            "x-workspace-id",
                            "x-session-id",
                        ]
                            .filter((name) => requestHeaders[name])
                            .map((name) => [name, requestHeaders[name]]),
                    ),
                    observedAt: new Date().toISOString(),
                });
            })
            .catch(() => {
                browserHttpFailures.push({
                    method: browserRequest.method(),
                    url,
                    resourceType: browserRequest.resourceType(),
                    status: response.status(),
                    problemCode: null,
                    problemDetail: null,
                    requestId: null,
                    correlationHeaders: {},
                    observedAt: new Date().toISOString(),
                    metadataCaptureFailed: true,
                });
            });
        httpFailureCaptures.push(capture);
    });
    page.on("request", (outgoing) => {
        if (outgoing.url().includes("/api/v1/chat/sessions")) {
            chatSessionRequests.push(outgoing.url());
        }
        if (outgoing.url().includes("/api/v1/chat")) {
            browserChatRequests.push(outgoing.method());
            if (outgoing.method() === "POST") {
                browserChatSubmissions.push({
                    idempotencyKey: outgoing.headers()["idempotency-key"] ?? null,
                    body: outgoing.postData() ?? "",
                });
            }
        }
    });
    page.on("response", async (response) => {
        if (
            !response.url().includes("/api/v1/sessions/") ||
            !response.url().endsWith("/derived-state")
        )
            return;
        try {
            derivedStateResponses.push({ status: response.status(), body: await response.json() });
        } catch {
            derivedStateResponses.push({ status: response.status(), body: {} });
        }
    });
    page.on("response", async (response) => {
        if (response.request().method() !== "GET") return;
        const pathname = new URL(response.url()).pathname;
        if (!pathname.startsWith("/api/v1/chat/sessions/") || !pathname.endsWith("/runs")) return;
        let body: unknown = null;
        try {
            body = await response.json();
        } catch {
            body = null;
        }
        sessionRunsResponses.push({ status: response.status(), url: response.url(), body });
    });

    const fakeHealth = await request.get(`${FAKE_LLM_URL}/health`);
    expect(fakeHealth.ok(), "spawn fake LLM must be ready").toBeTruthy();
    expect(((await fakeHealth.json()) as { mode: string }).mode).toBe("spawn_agent");

    const owner = await registerJourneyUser(request, "agent-spawn-host");
    const ownerMe = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: owner.headers });
    expect(ownerMe.ok(), await ownerMe.text()).toBeTruthy();
    const userId = requireUuid(((await ownerMe.json()) as { id: string }).id);
    const workspaceId = requireUuid(owner.workspaceId);
    const workspaceHeaders = { ...owner.headers, "X-Workspace-Id": workspaceId };
    seedUserSpawnPermissions(userId, workspaceId);
    // 会话创建要解析到"本用户的"READY chat 连接（instance 层 profile → 消费方 USER 连接）。
    await ensureFakeChatConnection(request, workspaceHeaders);

    // BL-314：能力走 instance 面角色绑定（创建时 roleIds）→ 再设 workspace cap。
    // 不再需要「空 cap 建绑定行 → workspace 绑角色」的三段顺序：那是 D-180「role=reach」下
    // 唯一会被 cap 门拒绝的走法（409 ROLE_BINDING_EXCEEDS_CAP，spawn11 实证）。
    const spawnRoleId = createSpawnCapabilityRole();
    const principalResponse = await request.post(`${CP_URL}/api/v1/agent-principals`, {
        headers: workspaceHeaders,
        data: { name: "CPMCPSpawnE2E", presetIds: [spawnRoleId] },
    });
    expect(principalResponse.status(), await principalResponse.text()).toBe(201);
    const principalId = requireUuid(
        ((await principalResponse.json()) as { principalId: string }).principalId,
    );

    const bindingResponse = await request.put(
        `${CP_URL}/api/v1/workspaces/${workspaceId}/agents/${principalId}`,
        {
            headers: workspaceHeaders,
            data: { permissions: [{ actionClass: "SPAWN_AGENT", resource: "*" }] },
        },
    );
    expect(bindingResponse.status(), await bindingResponse.text()).toBe(200);
    assertSpawnGrantSurvivedCapPut(principalId, spawnRoleId);
    await ensureAgentWorkspaceBinding(workspaceId);

    seedPage(page, owner);
    const workspaceFileToolRequestPromise = page.waitForRequest(
        (outgoing) => {
            if (outgoing.method() !== "POST" || !outgoing.url().includes("/api/v1/mcp"))
                return false;
            try {
                const payload = outgoing.postDataJSON() as {
                    method?: string;
                    params?: { name?: string; arguments?: { path?: string } };
                };
                return payload.method === "tools/call" && payload.params?.name === "list_directory";
            } catch {
                return false;
            }
        },
        { timeout: LONG_TIMEOUT_MS },
    );
    await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
    const workspaceFileToolRequest = await workspaceFileToolRequestPromise,
        workspaceFileToolResponse = await workspaceFileToolRequest.response();
    expect(
        workspaceFileToolResponse,
        "workspace UI list_directory must receive a response",
    ).not.toBeNull();
    expect(workspaceFileToolResponse!.status()).toBe(200);
    const workspaceFileRequestHeaders = await workspaceFileToolRequest.allHeaders(),
        workspaceFileResponseHeaders = await workspaceFileToolResponse!.allHeaders();
    expect(workspaceFileRequestHeaders.authorization).toBe(owner.headers.Authorization);
    expect(workspaceFileRequestHeaders["x-chat-run-id"]).toBeUndefined();
    expect(workspaceFileRequestHeaders["x-operation-id"]).toBeUndefined();
    expect(workspaceFileResponseHeaders["x-request-id"]).toBeTruthy();
    expect(await workspaceFileToolResponse!.json()).toHaveProperty("result");
    await expect(page.getByTestId("workspace-tree-loading")).toBeHidden({
        timeout: LONG_TIMEOUT_MS,
    });
    await expect
        .poll(
            async () =>
                (await page
                    .getByTestId("workspace-empty-state")
                    .isVisible()
                    .catch(() => false)) || (await page.getByRole("treeitem").count()) > 0,
            { timeout: LONG_TIMEOUT_MS },
        )
        .toBeTruthy();
    const emptyStateVisible = await page.getByTestId("workspace-empty-state").isVisible();
    const visibleTreeItemCount = await page.getByRole("treeitem").count();
    const visibleTreeState = emptyStateVisible
        ? "empty"
        : visibleTreeItemCount > 0
          ? "tree"
          : "unknown";
    expect(visibleTreeState).not.toBe("unknown");
    const workspaceFileRequestBody = workspaceFileToolRequest.postDataJSON() as {
        method: string;
        params: { name: string; arguments: { path?: string } };
    };
    const userRequestId = workspaceFileResponseHeaders["x-request-id"];
    expect(userRequestId).toMatch(UUID_PATTERN);
    const evidence = {
        method: workspaceFileRequestBody.method,
        tool: workspaceFileRequestBody.params.name,
        path: workspaceFileRequestBody.params.arguments.path ?? "",
        userBearerMatched:
            workspaceFileRequestHeaders.authorization === owner.headers.Authorization,
        hasAgentRunContext: Boolean(workspaceFileRequestHeaders["x-chat-run-id"]),
        hasAgentOperationContext: Boolean(workspaceFileRequestHeaders["x-operation-id"]),
        responseStatus: workspaceFileToolResponse!.status(),
        requestId: userRequestId,
        visibleTreeState,
        visibleTreeItemCount,
    };
    const evidenceJson = JSON.stringify(evidence, null, 2);
    const runId = (process.env.XIHE_E2E_RUN_ID ?? "manual").replace(/[^a-zA-Z0-9-]/g, "-");
    const evidencePath = resolve(
        process.cwd(),
        "../../.local/dev",
        `host-auth-${runId}-workspace-tree`,
    );
    const screenshot = await page.screenshot();
    await writeFile(`${evidencePath}.json`, evidenceJson);
    await writeFile(`${evidencePath}.png`, screenshot);
    process.stdout.write(
        `[PLAN-0420] host-auth-evidence=${evidencePath}.json; screenshot=${evidencePath}.png\n`,
    );
    await test.info().attach("workspace-ui-file-tool-auth.json", {
        body: evidenceJson,
        contentType: "application/json",
    });
    await test.info().attach("workspace-file-tree.png", {
        body: screenshot,
        contentType: "image/png",
    });
    const createSession = page.getByTestId("workspace-create-session");
    await expect(createSession).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await createSession.click();
    const principalPicker = page.getByTestId("workspace-agent-principal-select");
    await expect(principalPicker).toBeVisible();
    // BL-547（task-175）：reka Select —— 按 id 反查名字后点选项。
    await chooseWorkspacePrincipalById(page, principalPicker, principalId);
    const sessionResponsePromise = page.waitForResponse((response) =>
        isSessionCreateRequest(response.url(), response.request().method()),
    );
    await page.getByTestId("workspace-create-agent-session").click();
    const sessionResponse = await sessionResponsePromise;
    expect(sessionResponse.status(), await sessionResponse.text()).toBe(201);
    const createdParent = (await sessionResponse.json()) as { id: string; title?: string };
    const parentSessionId = requireUuid(createdParent.id);
    const parentSessionInitialTitle =
        createdParent.title ??
        queryIsolatedPostgres(`SELECT title FROM sessions WHERE id = '${parentSessionId}'::uuid`);
    await expect(page).toHaveURL(workspaceSessionPath(workspaceId, parentSessionId));
    await expect(page.getByTestId("chat-input")).toBeVisible();
    await expect
        .poll(
            () =>
                derivedStateResponses.some(
                    (item) => item.status === 200 && item.body.sessionId === parentSessionId,
                ),
            { timeout: LONG_TIMEOUT_MS },
        )
        .toBeTruthy();

    queryIsolatedPostgres(
        `UPDATE sessions SET approval_mode = 'manual' WHERE id = '${parentSessionId}'::uuid`,
    );
    const sessionView = await request.get(`${CP_URL}/api/v1/sessions/${parentSessionId}`, {
        headers: workspaceHeaders,
    });
    expect(sessionView.ok(), await sessionView.text()).toBeTruthy();
    expect(((await sessionView.json()) as { agentPrincipalId: string }).agentPrincipalId).toBe(
        principalId,
    );

    let childReleaseNeeded = false;
    try {
        const token = `spawn-${Date.now().toString(36)}`,
            derivedResponsesBeforeSpawn = derivedStateResponses.length;
        childReleaseNeeded = true;
        await sendSpawnMessage(page, `XIHE-E2E-SPAWN ${token}`);
        const approvalModal = page.locator('[data-testid="modal-content"]');
        await expect(approvalModal, "spawn must use the existing MCP approval gate").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await approvalModal.locator('[data-testid="approval-approve"]').click();
        await expect(approvalModal).toBeHidden({ timeout: LONG_TIMEOUT_MS });

        await expect
            .poll(
                async () => {
                    const stateResponse = await request.get(
                        `${FAKE_LLM_URL}/__test/spawn-child-state`,
                    );
                    if (!stateResponse.ok()) return -1;
                    return ((await stateResponse.json()) as { pending: number }).pending;
                },
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .toBe(1);

        // PLAN-0464 T2.1: the parent run and the spawn waiting link now come
        // from the Chat domain — no Operation row is involved.
        const parentRunsResponse = await request.get(
            `${CP_URL}/api/v1/chat/sessions/${parentSessionId}/runs?page=0&size=50`,
            { headers: workspaceHeaders },
        );
        expect(parentRunsResponse.ok(), await parentRunsResponse.text()).toBeTruthy();
        const parentRunsBody = (await parentRunsResponse.json()) as {
            runs?: Array<{ runId: string; origin: string; status: string }>;
        };
        const parentRunId = requireUuid(
            parentRunsBody.runs?.find((run) => run.origin === "user_submission")?.runId ?? "",
        );

        let childRunId = "",
            childSessionId = "";
        await expect
            .poll(
                () => {
                    const observed = derivedStateResponses
                        .slice(derivedResponsesBeforeSpawn)
                        .flatMap((item) =>
                            item.status === 200 ? (item.body.activeChildren ?? []) : [],
                        )[0];
                    if (!observed) return "";
                    childRunId = observed.runId;
                    childSessionId = observed.childSessionId;
                    return observed.runId;
                },
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .not.toBe("");
        childRunId = requireUuid(childRunId);
        childSessionId = requireUuid(childSessionId);
        const childName = queryIsolatedPostgres(
            `SELECT title FROM sessions WHERE id = '${childSessionId}'::uuid`,
        );
        expect(childName).not.toBe("");

        // Durable waiting link, read from the child ChatRun row through the
        // session-runs endpoint (the same read surface ChatPanel uses after a refresh).
        await expect
            .poll(
                async () => {
                    const runsResponse = await request.get(
                        `${CP_URL}/api/v1/chat/sessions/${childSessionId}/runs?page=0&size=50`,
                        { headers: workspaceHeaders },
                    );
                    if (!runsResponse.ok()) return "";
                    const runsBody = (await runsResponse.json()) as {
                        runs?: Array<{
                            runId: string;
                            waitingOnRunId?: string | null;
                            waitingToolCallId?: string | null;
                        }>;
                    };
                    const childRun = runsBody.runs?.find((run) => run.runId === childRunId);
                    return childRun &&
                        childRun.waitingOnRunId === parentRunId &&
                        childRun.waitingToolCallId
                        ? childRun.waitingOnRunId
                        : "";
                },
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .toBe(parentRunId);

        // Live (no reload): the projection must have populated the badge already.
        await expect(page.getByTestId("derived-active-child")).toContainText(childName);

        // PLAN-0464 note: the ToolCallCard `tool-call-waiting-on` badge is fed
        // only by the live streaming store (the messages API returns no
        // toolCalls for this branch), so the durable waiting-link evidence is
        // the endpoint network/DOM assertions below, not the badge.

        // PLAN-0464 V5: a reload while the child is still active forces the
        // panel's own mount path to rebuild the waiting projection from the
        // session-runs endpoint (refresh-recovery network + DOM evidence).
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("derived-active-child")).toContainText(childName, {
            timeout: LONG_TIMEOUT_MS,
        });
        // Diagnostic first: did the browser call the new endpoint at all?
        await expect
            .poll(() => chatSessionRequests.length, {
                timeout: LONG_TIMEOUT_MS,
                intervals: [250, 500, 1_000],
            })
            .toBeGreaterThan(0);
        expect(
            chatSessionRequests.some(
                (url) => new URL(url).pathname === `/api/v1/chat/sessions/${childSessionId}/runs`,
            ),
            JSON.stringify(chatSessionRequests, null, 2),
        ).toBeTruthy();
        await expect
            .poll(() => sessionRunsResponses.length, {
                timeout: LONG_TIMEOUT_MS,
                intervals: [250, 500, 1_000],
            })
            .toBeGreaterThan(0);
        expect(
            sessionRunsResponses.some(
                (response) =>
                    response.status === 200 &&
                    new URL(response.url).pathname ===
                        `/api/v1/chat/sessions/${childSessionId}/runs`,
            ),
            JSON.stringify(sessionRunsResponses, null, 2),
        ).toBeTruthy();

        expect(
            sessionRunsResponses.some((response) => {
                const body = response.body as {
                    runs?: Array<{ runId: string; waitingToolCallId?: string | null }>;
                } | null;
                return !!body?.runs?.some(
                    (run) => run.runId === childRunId && !!run.waitingToolCallId,
                );
            }),
            JSON.stringify(sessionRunsResponses, null, 2),
        ).toBeTruthy();
        const waitingOnScreenshot = test.info().outputPath("tool-call-waiting-on-active.png");
        await page.screenshot({ scale: "css", path: waitingOnScreenshot, fullPage: false });
        await test.info().attach("tool-call-waiting-on-active.png", {
            path: waitingOnScreenshot,
            contentType: "image/png",
        });

        await test.info().attach("child-run-waiting-link.json", {
            body: JSON.stringify(
                {
                    parentRunId,
                    childRunId,
                    childSessionId,
                    endpoint: "GET /api/v1/chat/sessions/{id}/runs",
                },
                null,
                2,
            ),
        });

        const childSessionResponse = await request.get(
            `${CP_URL}/api/v1/sessions/${childSessionId}`,
            {
                headers: workspaceHeaders,
            },
        );
        expect(childSessionResponse.ok(), await childSessionResponse.text()).toBeTruthy();
        const childSession = (await childSessionResponse.json()) as {
            id: string;
            workspaceId: string;
            agentPrincipalId: string;
        };
        expect(childSession).toMatchObject({
            id: childSessionId,
            workspaceId,
            agentPrincipalId: principalId,
        });
        expect(
            scalarCount(
                `SELECT count(*) FROM sessions WHERE id = '${childSessionId}'::uuid ` +
                    `AND spawned_from_run_id = '${parentRunId}'::uuid AND kind = 'spawn'`,
            ),
        ).toBe(1);
        expect(
            scalarCount(
                `SELECT count(*) FROM audit_logs WHERE action = 'agent_spawn_created' AND resource_id = '${childSessionId}'`,
            ),
        ).toBe(1);

        const parentAssistant = page.locator('[data-slot="message"][data-align="start"]').last();
        await expect(parentAssistant).toContainText("SPAWN_PARENT_DONE child dispatched", {
            timeout: LONG_TIMEOUT_MS,
        });
        const parentRunStatus = queryIsolatedPostgres(
            `SELECT status FROM chat_runs WHERE id = '${parentRunId}'::uuid`,
        );
        expect(parentRunStatus).toBe("succeeded");

        const derivedResponsesBeforeTerminal = derivedStateResponses.length;
        const releaseResponse = await request.post(`${FAKE_LLM_URL}/__test/release-spawn-child`);
        expect(releaseResponse.ok(), await releaseResponse.text()).toBeTruthy();
        expect(((await releaseResponse.json()) as { released: number }).released).toBe(1);
        childReleaseNeeded = false;

        await expect
            .poll(
                async () =>
                    queryIsolatedPostgres(
                        `SELECT status FROM chat_runs WHERE id = '${childRunId}'::uuid`,
                    ),
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .toBe("succeeded");
        await expect
            .poll(
                () =>
                    derivedStateResponses
                        .slice(derivedResponsesBeforeTerminal)
                        .some(
                            (item) =>
                                item.status === 200 &&
                                item.body.terminalNotices?.some(
                                    (notice) =>
                                        notice.runId === childRunId && notice.state === "success",
                                ),
                        ),
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .toBeTruthy();
        await expect(page.getByTestId("derived-terminal-notice")).toContainText(childName);
        await expect(page.getByTestId("derived-active-child")).toHaveCount(0);
        await expect(page.getByTestId("tool-call-waiting-on")).toHaveCount(0);
        const terminalScreenshotPath = test.info().outputPath("derived-state-terminal-visible.png");
        await page.screenshot({ scale: "css", path: terminalScreenshotPath, fullPage: false });
        await test.info().attach("derived-state-terminal-visible.png", {
            path: terminalScreenshotPath,
            contentType: "image/png",
        });

        const derivedResponsesBeforeReconnect = derivedStateResponses.length;
        await page.goto(`/workspace/${workspaceId}`, { waitUntil: "load" });
        await page.goto(workspaceSessionPath(workspaceId, parentSessionId), { waitUntil: "load" });
        await expect(page.getByTestId("derived-terminal-notice")).toContainText(childName);
        await expect
            .poll(
                () =>
                    derivedStateResponses
                        .slice(derivedResponsesBeforeReconnect)
                        .some(
                            (item) =>
                                item.status === 200 &&
                                item.body.terminalNotices?.some(
                                    (notice) => notice.runId === childRunId,
                                ),
                        ),
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .toBeTruthy();

        const derivedResponsesBeforeReload = derivedStateResponses.length;
        await page.reload({ waitUntil: "load" });
        await expect(page.getByTestId("derived-terminal-notice")).toContainText(childName);
        await expect
            .poll(
                () =>
                    derivedStateResponses
                        .slice(derivedResponsesBeforeReload)
                        .some(
                            (item) =>
                                item.status === 200 &&
                                item.body.terminalNotices?.some(
                                    (notice) => notice.runId === childRunId,
                                ),
                        ),
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .toBeTruthy();

        // Child terminal settles the waiting link on the child ChatRun itself.
        await expect
            .poll(
                async () => {
                    const runsResponse = await request.get(
                        `${CP_URL}/api/v1/chat/sessions/${childSessionId}/runs?page=0&size=50`,
                        { headers: workspaceHeaders },
                    );
                    if (!runsResponse.ok()) return "unavailable";
                    const runsBody = (await runsResponse.json()) as {
                        runs?: Array<{ runId: string; waitingOnRunId?: string | null }>;
                    };
                    return (
                        runsBody.runs?.find((run) => run.runId === childRunId)?.waitingOnRunId ??
                        null
                    );
                },
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .toBe(null);

        const childBranchId = await getRootBranchId(request, childSessionId, workspaceHeaders);
        const childMessagesResponse = await request.get(
            `${CP_URL}/api/v1/sessions/${childSessionId}/messages?branchId=${childBranchId}`,
            { headers: workspaceHeaders },
        );
        expect(childMessagesResponse.ok(), await childMessagesResponse.text()).toBeTruthy();
        const childMessages = (await childMessagesResponse.json()) as Array<{
            role?: string;
            content?: string;
        }>;
        expect(
            childMessages.some(
                (message) =>
                    message.role.toLowerCase() === "assistant" &&
                    message.content?.includes("SPAWN_CHILD_DONE"),
            ),
        ).toBe(true);

        const pendingInboxId = requireUuid(
            queryIsolatedPostgres(
                `SELECT id FROM inbox WHERE to_session_id = '${parentSessionId}'::uuid AND injected_run_id IS NULL`,
            ),
        );
        const parentRunsBeforeClaim = scalarCount(
            `SELECT count(*) FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid`,
        );
        const parentInvocationsBeforeClaim = scalarCount(
            `SELECT count(*) FROM mcp_invocations WHERE session_id = '${parentSessionId}'::uuid`,
        );
        const submissionsBeforeClaim = browserChatSubmissions.length;
        await sendChat(page, `Acknowledge completed child ${token}`);
        await expect.poll(() => browserChatSubmissions.length).toBe(submissionsBeforeClaim + 1);

        const claimSubmission = browserChatSubmissions.at(-1);
        expect(claimSubmission?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
        expect(claimSubmission?.body).not.toBe("");
        const claimBody = JSON.parse(claimSubmission!.body) as { sessionId?: string };
        expect(claimBody.sessionId).toBe(parentSessionId);
        await expect
            .poll(
                () =>
                    scalarCount(
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid`,
                    ),
                { timeout: LONG_TIMEOUT_MS, intervals: [100, 250, 500] },
            )
            .toBe(parentRunsBeforeClaim + 1);

        const claimRunId = requireUuid(
            queryIsolatedPostgres(
                `SELECT id FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid ORDER BY created_at DESC LIMIT 1`,
            ),
        );
        const claimedRunId = () =>
            queryIsolatedPostgres(
                `SELECT injected_run_id FROM inbox WHERE id = '${pendingInboxId}'::uuid`,
            );
        await expect
            .poll(claimedRunId, { timeout: LONG_TIMEOUT_MS, intervals: [100, 250, 500] })
            .toBe(claimRunId);
        expect((claimBody as { branchId?: string }).branchId).toBeTruthy();

        const replayResponse = await request.post(`${CP_URL}/api/v1/chat`, {
            headers: {
                ...workspaceHeaders,
                "Content-Type": "application/json",
                "Idempotency-Key": claimSubmission!.idempotencyKey!,
            },
            data: claimSubmission!.body,
        });
        expect(replayResponse.status(), await replayResponse.text()).toBe(202);
        const replay = (await replayResponse.json()) as { runId?: string; operationId?: string };
        expect(replay.runId).toBe(claimRunId);
        // Idempotent replay must not create another durable invocation.
        expect(replay.operationId).toBeUndefined();
        expect(
            scalarCount(
                `SELECT count(*) FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid`,
            ),
        ).toBe(parentRunsBeforeClaim + 1);
        expect(claimedRunId()).toBe(claimRunId);
        expect(
            scalarCount(
                `SELECT count(*) FROM mcp_invocations WHERE session_id = '${parentSessionId}'::uuid`,
            ),
        ).toBe(parentInvocationsBeforeClaim);

        await expect
            .poll(
                () =>
                    queryIsolatedPostgres(
                        `SELECT status FROM chat_runs WHERE id = '${claimRunId}'::uuid`,
                    ),
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .toBe("succeeded");
        await expect(page.getByText("SPAWN_CHILD_READY", { exact: true })).toBeVisible();
        const inboxClaimScreenshotPath = test.info().outputPath("inbox-claim-run-completed.png");
        await page.screenshot({ scale: "css", path: inboxClaimScreenshotPath, fullPage: false });
        await test.info().attach("inbox-claim-run-completed.png", {
            path: inboxClaimScreenshotPath,
            contentType: "image/png",
        });

        const claimReplayEvidencePath = test.info().outputPath("inbox-claim-replay.json");
        await writeFile(
            claimReplayEvidencePath,
            JSON.stringify(
                {
                    parentSessionId,
                    childSessionId,
                    childRunId,
                    inboxId: pendingInboxId,
                    claimRunId,
                    replayRunId: replay.runId,
                    inboxInjectedRunId: claimedRunId(),
                    runCount: scalarCount(
                        `SELECT count(*) FROM chat_runs WHERE session_id = '${parentSessionId}'::uuid`,
                    ),
                    mcpInvocationCount: scalarCount(
                        `SELECT count(*) FROM mcp_invocations WHERE session_id = '${parentSessionId}'::uuid`,
                    ),
                },
                null,
                2,
            ),
        );
        await test.info().attach("inbox-claim-replay.json", {
            path: claimReplayEvidencePath,
            contentType: "application/json",
        });

        // D-1866: CP's `SessionTitleDeriver` rewrites the title from the first user message,
        // so the title captured at creation time is stale by now. Read the derived title back
        // by session id (the same `sessions.title` the sidebar renders) instead of pinning a
        // literal, then locate the parent row by that derived title and assert it is the row
        // carrying `aria-current` — the child must not steal the highlight.
        await expect
            .poll(
                () =>
                    queryIsolatedPostgres(
                        `SELECT title FROM sessions WHERE id = '${parentSessionId}'::uuid`,
                    ),
                { timeout: LONG_TIMEOUT_MS, intervals: [250, 500, 1_000] },
            )
            .not.toBe(parentSessionInitialTitle);
        const derivedParentTitle = queryIsolatedPostgres(
            `SELECT title FROM sessions WHERE id = '${parentSessionId}'::uuid`,
        );
        // The spawned child's task reuses the parent message, so both derivations can be the
        // same string (`XIHE-E2E-SPAWN …`); the title cannot tell the two rows apart. The
        // current-workspace list also renders rows without the standalone list's
        // `data-session-id` wrapper (plan-0507), so the unique `aria-current` row is the
        // identity check here (one resolved element, see the 896 reading).
        const parentSessionItem = page.locator('[data-testid="session-item"][aria-current="page"]');
        await expect(parentSessionItem).toBeVisible();
        await expect(parentSessionItem).toContainText(derivedParentTitle);
        await parentSessionItem.click({ button: "right" });
        await page.getByTestId("session-item-delete").click();
        const deleteWarning = page.getByTestId("session-delete-warning");
        await expect(deleteWarning).toBeVisible();
        await expect(page.getByTestId("modal-backdrop")).toHaveCSS("opacity", "1");
        await expect(deleteWarning).toContainText(
            /子会话和运行会保留|Spawned child sessions and runs remain/,
        );
        const confirmDelete = page.getByTestId("session-delete-confirm");
        await expect(confirmDelete).toBeVisible();
        const deleteButtonStyle = await confirmDelete.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
                color: style.color,
                backgroundColor: style.backgroundColor,
                pointerEvents: style.pointerEvents,
            };
        });
        expect(deleteButtonStyle.pointerEvents).toBe("auto");
        expect(deleteButtonStyle.color).not.toBe(deleteButtonStyle.backgroundColor);
        const deleteWarningScreenshotPath = test.info().outputPath("parent-delete-warning.png");
        await page.screenshot({ scale: "css", path: deleteWarningScreenshotPath, fullPage: false });
        await test.info().attach("parent-delete-warning.png", {
            path: deleteWarningScreenshotPath,
            contentType: "image/png",
        });
        await confirmDelete.click();
        await expect(deleteWarning).toHaveCount(0);
        expect(
            scalarCount(`SELECT count(*) FROM sessions WHERE id = '${parentSessionId}'::uuid`),
        ).toBe(0);
        expect(
            scalarCount(
                `SELECT count(*) FROM inbox WHERE to_session_id = '${parentSessionId}'::uuid`,
            ),
        ).toBe(0);
        expect(
            scalarCount(`SELECT count(*) FROM sessions WHERE id = '${childSessionId}'::uuid`),
        ).toBe(1);
        expect(scalarCount(`SELECT count(*) FROM chat_runs WHERE id = '${childRunId}'::uuid`)).toBe(
            1,
        );

        // BL-315（2026-11-05 定性，Lead 裁定 A 类）：父会话被删 ⇒ 子会话委派树"断根"，read-only
        // 预算视图按设计 fail-closed：CP `DelegationBudgetService.treeBroken()`
        // （DelegationBudgetService.java:425-429）返回 409 DELEGATION_POLICY_INVALID，UI
        // `SessionList.vue:106-119` 已 catch+warn（不抛错、不渲染预算 chip）。这是**预期失败**，
        // 因此这里显式断言它的形态，并在文末把它单独登记进噪声白名单；其余噪声仍要求为空。
        const childDelegationUsagePath = `/api/v1/sessions/${childSessionId}/delegation-usage`;
        const expectedDelegationUsage409 = page.waitForResponse(
            (response) =>
                response.request().method() === "GET" &&
                new URL(response.url()).pathname === childDelegationUsagePath,
            { timeout: LONG_TIMEOUT_MS },
        );
        await page.goto(workspaceSessionPath(workspaceId, childSessionId), { waitUntil: "load" });
        await expect(page).toHaveURL(workspaceSessionPath(workspaceId, childSessionId));
        await expect(page.getByTestId("chat-input")).toBeVisible();
        await expect(page.getByTestId("workspace-tree-loading")).toBeHidden({
            timeout: LONG_TIMEOUT_MS,
        });
        const delegationUsageResponse = await expectedDelegationUsage409;
        expect(delegationUsageResponse.status(), "the budget view fails closed").toBe(409);
        const delegationUsageProblem = (await delegationUsageResponse.json()) as {
            code?: string;
            detail?: string;
        };
        expect(delegationUsageProblem.code).toBe("DELEGATION_POLICY_INVALID");
        // wire 上的 detail 形态（spawn15 实测）：
        // 「Delegation ancestor is missing: spawn ancestor session <uuid>」。
        expect(delegationUsageProblem.detail ?? "").toMatch(/Delegation ancestor is missing/i);
        // UI 降级可见性：子会话行照常渲染（delegated 徽标在），但预算 chip 不得出现。
        await expect(page.getByTestId("session-delegated-badge").first()).toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        await expect(page.getByTestId("session-delegation-chip")).toHaveCount(0);
        const childAfterDeleteScreenshotPath = test
            .info()
            .outputPath("child-after-parent-delete.png");
        await page.screenshot({
            scale: "css",
            path: childAfterDeleteScreenshotPath,
            fullPage: false,
        });
        await test.info().attach("child-after-parent-delete.png", {
            path: childAfterDeleteScreenshotPath,
            contentType: "image/png",
        });

        await Promise.allSettled(httpFailureCaptures);
        expect(browserChatRequests).toContain("POST");
        /**
         * 契约（全文件唯一登记项，**不是豁免**）：父会话删除后，子会话的团队板与委派预算视图
         * 都按设计 fail-closed，回一条 409：
         * - `GET /api/v1/sessions/<本次 childSessionId>/team-tasks`
         *   ⇒ 409 `TEAM_TASK_TREE_BROKEN`，detail 以 `ancestor_missing: spawn ancestor session …` 开头
         *   （CP `TeamTaskService.boardOf()` 捕获 `DelegationChainWalker.AncestorMissingException`）；
         * - `GET /api/v1/sessions/<本次 childSessionId>/delegation-usage`
         *   ⇒ 409 `DELEGATION_POLICY_INVALID`，detail 为 `Delegation ancestor is missing: …`
         *   （CP `DelegationBudgetService.treeBroken()`）。
         * 这是**契约**（父删后子会话团队板 fail-closed），不是把缺陷洗成夹具噪声：白名单按
         * `method + 精确 pathname + status + problem.code + problem.detail` 五要素逐条匹配，
         * **禁止** `status === 409` 或 `code` 单条件放行；任何其它失败一律判红。
         * 失效条件：若将来产品改语义 (a)（父删后子会话团队板回退为自己当根 / 团队板仍可用），
         * 后端不再返回这两条 409 ⇒ **此过滤器必须删除**，并把断言改成「200 + 团队板可读」。
         * 详见 task-909 与 `internal/A03-xihe/docs/backlog` BL-642。
         */
        const childTeamTasksPath = `/api/v1/sessions/${childSessionId}/team-tasks`;
        const expectedParentDeleteFailClosed: Array<{
            method: string;
            pathname: string;
            status: number;
            code: string;
            detail: RegExp;
        }> = [
            {
                method: "GET",
                pathname: childTeamTasksPath,
                status: 409,
                code: "TEAM_TASK_TREE_BROKEN",
                detail: /ancestor_missing/i,
            },
            {
                method: "GET",
                pathname: childDelegationUsagePath,
                status: 409,
                code: "DELEGATION_POLICY_INVALID",
                detail: /ancestor_missing|ancestor is missing/i,
            },
        ];
        const isExpectedDelegationUsageAfterParentDelete = (failure: {
            method: string;
            url: string;
            status: number;
            problemCode: string | null;
            problemDetail: string | null;
        }): boolean => {
            const pathname = new URL(failure.url).pathname;
            return expectedParentDeleteFailClosed.some(
                (expected) =>
                    failure.method === expected.method &&
                    pathname === expected.pathname &&
                    failure.status === expected.status &&
                    failure.problemCode === expected.code &&
                    expected.detail.test(failure.problemDetail ?? ""),
            );
        };
        const expectedHttpFailures = browserHttpFailures.filter(
            isExpectedDelegationUsageAfterParentDelete,
        );
        expect(
            [
                ...new Set(expectedHttpFailures.map((failure) => new URL(failure.url).pathname)),
            ].sort(),
            "both fail-closed 409s must still be observed (else the whitelist is stale)",
        ).toEqual([childDelegationUsagePath, childTeamTasksPath].sort());
        const unexpectedHttpFailures = browserHttpFailures.filter(
            (failure) => !isExpectedDelegationUsageAfterParentDelete(failure),
        );
        expect(unexpectedHttpFailures, JSON.stringify(unexpectedHttpFailures, null, 2)).toEqual([]);
        const isExpectedConsoleError = (event: (typeof consoleErrorEvents)[number]): boolean =>
            expectedParentDeleteFailClosed.some((expected) =>
                event.sourceUrl.endsWith(expected.pathname),
            ) && /409/.test(event.text);
        const unexpectedConsoleErrors = consoleErrorEvents
            .filter((event) => !isExpectedConsoleError(event))
            .map((event) => event.text);
        expect(unexpectedConsoleErrors, JSON.stringify(unexpectedConsoleErrors, null, 2)).toEqual(
            [],
        );
        expect(apiFailures).toEqual([]);
        expect(derivedStateResponses.every((item) => item.status === 200)).toBe(true);
        // 放在最后：BL-315（`<MessageScrollerContent>` 递归）由 lane-mscroll 修，修好后本行即绿。
        expect(pageErrors).toEqual([]);

        await test.info().attach("agent-spawn-evidence.json", {
            body: Buffer.from(
                JSON.stringify(
                    {
                        parentSessionId,
                        parentRunId,
                        sessionRunsRequests: sessionRunsResponses.length,
                        childSessionId,
                        childRunId,
                        principalId,
                        browserChatRequests,
                        // BL-315 证据：删父后子会话预算视图的 fail-closed 409（预期，已显式登记）。
                        delegationUsageAfterParentDelete: {
                            path: childDelegationUsagePath,
                            status: delegationUsageResponse.status(),
                            code: delegationUsageProblem.code,
                            detail: delegationUsageProblem.detail,
                            requestId: expectedHttpFailures[0]?.requestId ?? null,
                            observedFailures: expectedHttpFailures.length,
                            whitelistedConsoleErrors:
                                consoleErrorEvents.filter(isExpectedConsoleError).length,
                        },
                    },
                    null,
                    2,
                ),
            ),
            contentType: "application/json",
        });
    } finally {
        await Promise.allSettled(httpFailureCaptures);
        const browserErrorsPath = test.info().outputPath("host-browser-errors.json");
        await writeFile(
            browserErrorsPath,
            JSON.stringify(
                { consoleErrorEvents, browserHttpFailures, pageErrors, apiFailures },
                null,
                2,
            ),
        );
        await test.info().attach("host-browser-errors.json", {
            path: browserErrorsPath,
            contentType: "application/json",
        });
        if (childReleaseNeeded) {
            const release = await request
                .post(`${FAKE_LLM_URL}/__test/release-spawn-child`)
                .catch((cause) => {
                    console.warn("Could not release fake spawn child during test cleanup", cause);
                    return null;
                });
            if (release && !release.ok()) {
                console.warn("Fake spawn child cleanup returned an error", release.status());
            }
        }
    }
});
