import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { generateE2EPassword } from "./helpers/password";
import { ensureAgentWorkspaceBinding, getRootBranchId } from "./helpers/journey";
import { test, expect } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const EVIDENCE_DIR = path.resolve(process.cwd(), "../../.local/evidence/plan0366");

// PLAN-0366 T2.3：MCP 状态可见 + 单 job 取消的真实 host 证据。
// 跑法：
//   node scripts/e2e-host.mjs --retries=0 --llm-mode=job-cancel e2e/real/plan0366-mcp-status-job-cancel.spec.ts
// 场景：S1 stdio 徽章（ready/failed/无记录）；S2 同 run 两个 job 取消其中之一
// （run 继续、另一 job 不受影响、取消未确认反馈）；S4 越权 404；S5 审计事件。
const STDIO_FIXTURE_SCRIPT = [
    "const readline=require('readline');",
    "const rl=readline.createInterface({input:process.stdin});",
    "rl.on('line',(l)=>{let m;try{m=JSON.parse(l)}catch{return}",
    "if(m.method==='initialize'){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'xihe-e2e',version:'0'}}}))}",
    "else if(m.method==='notifications/initialized'){}",
    "else if(m.method==='tools/list'){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'e2e_echo',description:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}}))}",
    "else if(m.method==='tools/call'){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'echo'}]}}))}",
    "else{console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'method not found'}}))}});",
].join("");

test.describe("@host PLAN-0366 MCP status + single job cancel", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(360000);

    // PLAN-290 约束：Agent 每进程只绑定一个 workspace，全部用例共享同一注册用户/工作区。
    let sharedAuth: string;
    let sharedWs: string;
    let sharedHeaders: Record<string, string>;
    /** cad8e727 后会话必须挂 agentPrincipalId：套件级 bootstrap 出的共享会话。 */
    let suiteSessionId = "";

    test.beforeAll(async ({ request }) => {
        const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email: `plan0366-${Date.now()}@test.com`, password, name: "Plan0366" },
        });
        expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(
            reg.status(),
        );
        const auth = await reg.json();
        sharedAuth = auth.accessToken;
        sharedWs = auth.workspaceId;
        sharedHeaders = {
            Authorization: `Bearer ${auth.accessToken}`,
            "Content-Type": "application/json",
        };

        // PLAN-0465 T3.2 调整（plan0366 入口随 cad8e727/0401 IA 迁移）：
        // fresh workspace 无 agent binding → UI「新建对话」只能 toast、零会话
        // composer 不渲染；照 session-branch 既有模式 API bootstrap
        // grants → 模板 → principal → binding → 会话，S2 直接进 chat 路由。
        // 模板 role 含 `exec`（start/cancel_background_process 的 actionClass，
        // ToolFaceRegistry ACTION_EXEC）+ read/write。
        const bootHeaders = { ...sharedHeaders, "X-Workspace-Id": sharedWs };
        const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: bootHeaders });
        expect(me.ok(), await me.text()).toBeTruthy();
        const userId = ((await me.json()) as { id: string }).id;
        seedUserGrant(userId, sharedWs);

        const roleId = randomUUID();
        const templateId = randomUUID();
        const rolePermissions = JSON.stringify([
            { actionClass: "read", resource: "*" },
            { actionClass: "write", resource: "*" },
            { actionClass: "exec", resource: "*" },
        ]);
        const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers: bootHeaders,
            data: {
                roles: JSON.stringify([
                    {
                        id: roleId,
                        name: "Plan0366 Role",
                        permissions: JSON.parse(rolePermissions) as unknown[],
                    },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "Plan0366 Agent",
                        description: "Workspace-bound host fixture for job cancel verification",
                        systemPrompt: "Respond briefly using only the current chat context.",
                        toolMode: "workspace",
                        provider: "openai",
                        model: "fake-openai",
                        roleId,
                    },
                ]),
            },
        });
        expect(templateWrite.status(), await templateWrite.text()).toBe(200);

        const principalRes = await request.post(`${CP_URL}/api/v1/agent-principals`, {
            headers: bootHeaders,
            data: { name: "Plan0366 Agent", templateId },
        });
        expect(principalRes.status(), await principalRes.text()).toBe(201);
        const principalId = ((await principalRes.json()) as { principalId: string }).principalId;
        const binding = await request.put(
            `${CP_URL}/api/v1/workspaces/${sharedWs}/agents/${principalId}`,
            {
                headers: bootHeaders,
                data: { permissions: JSON.parse(rolePermissions) as unknown[] },
            },
        );
        expect(binding.status(), await binding.text()).toBe(200);

        const sessionRes = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers: bootHeaders,
            data: { title: "Plan0366 job cancel session", agentPrincipalId: principalId },
        });
        expect(sessionRes.status(), await sessionRes.text()).toBe(201);
        suiteSessionId = ((await sessionRes.json()) as { id: string }).id;
    });

    function seedPage(page: import("@playwright/test").Page, token: string, wsId: string) {
        page.addInitScript((t) => localStorage.setItem("xihe-token", t), token);
        page.addInitScript(
            (raw) => localStorage.setItem("xihe-user", raw),
            JSON.stringify({ workspaceId: wsId }),
        );
        page.addInitScript((ws) => localStorage.setItem("xihe-workspace", JSON.stringify(ws)), {
            id: wsId,
            name: "Default Workspace",
        });
        page.addInitScript(() => localStorage.setItem("xihe-language", "zh-CN"));
    }

    async function putStdioServers(
        request: import("@playwright/test").APIRequestContext,
        servers: Record<string, unknown>,
    ) {
        const current = await request.get(`${CP_URL}/api/v1/workspaces/${sharedWs}/stdio-servers`, {
            headers: sharedHeaders,
        });
        expect(current.ok(), `stdio-servers read failed: ${current.status()}`).toBeTruthy();
        const { generation } = await current.json();
        const put = await request.put(`${CP_URL}/api/v1/workspaces/${sharedWs}/stdio-servers`, {
            headers: sharedHeaders,
            data: { generation, servers },
        });
        expect(
            put.ok(),
            `stdio-servers write failed: ${put.status()} ${await put.text()}`,
        ).toBeTruthy();
    }

    async function triggerMcpToolsList(request: import("@playwright/test").APIRequestContext) {
        const mcpHeaders = {
            ...sharedHeaders,
            Accept: "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "X-Workspace-Id": sharedWs,
        };
        const init = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: mcpHeaders,
            timeout: 120000,
            data: {
                jsonrpc: "2.0",
                method: "initialize",
                id: 1,
                params: {
                    protocolVersion: "2026-07-28",
                    capabilities: {},
                    clientInfo: { name: "plan0366", version: "0.1.0" },
                },
            },
        });
        expect(init.status(), `initialize failed: ${init.status()}`).toBe(200);
        const list = await request.post(`${CP_URL}/api/v1/mcp`, {
            headers: mcpHeaders,
            timeout: 120000,
            data: { jsonrpc: "2.0", method: "tools/list", id: 2, params: {} },
        });
        expect(list.status(), `tools/list failed: ${list.status()} ${await list.text()}`).toBe(200);
    }

    /** 工作区会话 id（新用户唯一会话）。 */
    async function resolveSessionId(
        request: import("@playwright/test").APIRequestContext,
    ): Promise<string> {
        const res = await request.get(`${CP_URL}/api/v1/sessions`, { headers: sharedHeaders });
        expect(res.ok()).toBeTruthy();
        const body = (await res.json()) as { sessions?: Array<{ id: string }> };
        const id = body.sessions?.[0]?.id;
        expect(id, "workspace chat session").toBeTruthy();
        return id!;
    }

    /**
     * PLAN-0464/0465：ChatRun 不再有 chat operation root，run 收敛以
     * `GET /chat/runs/{runId}` 为关联面（messages DTO 每条消息带 runId）。
     */
    async function latestRunId(
        request: import("@playwright/test").APIRequestContext,
        sessionId: string,
    ): Promise<string> {
        const branchId = await getRootBranchId(request, sessionId, sharedHeaders);
        const res = await request.get(
            `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${branchId}`,
            { headers: sharedHeaders },
        );
        if (!res.ok()) return "";
        const messages = (await res.json()) as Array<{ runId?: string }>;
        const runIds = messages.map((message) => message.runId).filter(Boolean);
        return runIds.at(-1) ?? "";
    }

    async function awaitLatestChatRunTerminal(
        request: import("@playwright/test").APIRequestContext,
        sessionId: string,
    ): Promise<string> {
        let runId = "";
        await expect
            .poll(
                async () => {
                    runId = await latestRunId(request, sessionId);
                    return runId ? "found" : "missing";
                },
                {
                    timeout: 120000,
                    intervals: [1000, 2000],
                    message: "chat run id appears in the messages DTO",
                },
            )
            .toBe("found");
        let status = "";
        await expect
            .poll(
                async () => {
                    const res = await request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, {
                        headers: sharedHeaders,
                    });
                    if (!res.ok()) return `http-${res.status()}`;
                    const body = (await res.json()) as { status?: string };
                    status = body.status ?? "unknown";
                    return status;
                },
                {
                    timeout: 120000,
                    intervals: [500, 1000, 2000],
                    message: "chat run settles without being cancelled",
                },
            )
            .toMatch(/^(succeeded|failed|partial|cancelled|ambiguous)$/);
        return status;
    }

    /** S5 domain history：直接查 `workspace_job_history`（PLAN-0462 decision #8）。 */
    function queryIsolatedPostgres(sql: string): string {
        const container = process.env.XIHE_E2E_PG_CONTAINER;
        const database = process.env.XIHE_E2E_PG_DATABASE;
        const user = process.env.XIHE_E2E_PG_USER;
        if (!container || !database || !user) {
            throw new Error(
                "isolated Postgres fixture metadata is unavailable; run through scripts/e2e-host.mjs",
            );
        }
        return execFileSync(
            process.platform === "win32" ? "docker.exe" : "docker",
            ["exec", container, "psql", "-X", "-A", "-t", "-U", user, "-d", database, "-c", sql],
            { encoding: "utf8", timeout: 15_000, windowsHide: true },
        ).trim();
    }

    /** 会话消息里的 job 档案摘要（顺序 = 工具调用顺序）。 */
    async function jobSummaries(
        request: import("@playwright/test").APIRequestContext,
        sessionId: string,
    ): Promise<Array<{ jobId: string; workspaceId?: string; status?: string }>> {
        const branchId = await getRootBranchId(request, sessionId, sharedHeaders);
        const res = await request.get(
            `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${branchId}`,
            {
                headers: sharedHeaders,
            },
        );
        expect(res.ok(), `messages DTO ${res.status()}`).toBeTruthy();
        const messages = (await res.json()) as Array<{
            jobSummary?: Array<{ jobId?: string; workspaceId?: string; status?: string }>;
        }>;
        // 同一工具调用会双份出现在 parts 与 tool-result 消息 → 按 jobId 去重保序
        // （PLAN-0465 decision #7：jobId = domain 身份，itemId 已从 jobSummary 移除）。
        const unique = new Map<string, { jobId: string; workspaceId?: string; status?: string }>();
        for (const job of messages.flatMap((message) => message.jobSummary ?? [])) {
            if (job.jobId && !unique.has(job.jobId)) {
                unique.set(job.jobId, {
                    jobId: job.jobId,
                    workspaceId: job.workspaceId,
                    status: job.status,
                });
            }
        }
        return [...unique.values()];
    }

    /** 反复批准直至确定性 follow-up 文本出现（一次 run 两个 start 工具 = 两次审批）。 */
    async function approveUntil(page: import("@playwright/test").Page, doneText: string) {
        const modal = page.locator('[data-testid="modal-content"]');
        const approve = modal.locator('[data-testid="approval-approve"]');
        await expect
            .poll(
                async () => {
                    if (
                        await page
                            .getByText(doneText)
                            .isVisible()
                            .catch(() => false)
                    )
                        return "done";
                    if (await approve.isVisible().catch(() => false)) {
                        await approve.click().catch(() => {});
                        return "approved";
                    }
                    return "waiting";
                },
                {
                    timeout: 180000,
                    intervals: [1000, 2000],
                    message: `approvals until: ${doneText}`,
                },
            )
            .toBe("done");
        await expect(page.getByText(doneText)).toBeVisible({ timeout: 60000 });
    }

    test("S1: stdio status badges (ready/failed/no-session) are visible in the settings page", async ({
        page,
        request,
    }) => {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        // 一次 PUT 配置三个 server（配置 hash 变化会让 Runtime 停掉全部会话，禁止二次 PUT）：
        // A=可用 fixture；B=不存在的命令（重试预算耗尽后 failed）；C=无 command 的配置
        // （Runtime fetch 跳过无 command 项 → 永远没有会话 → 「无记录」行）。
        await putStdioServers(request, {
            "e2e-stdio": { command: "node", args: ["-e", STDIO_FIXTURE_SCRIPT] },
            "e2e-broken": { command: "definitely-not-a-real-binary-0366", args: [] },
            "e2e-idle": {},
        });
        await triggerMcpToolsList(request);
        // 失败可见性：命令不存在时 exec attach 创建成功、失败发生在往返阶段；0347 的
        // 失败预算按 start_process 错误累计且每请求在 exec start 成功时重置 → 真实栈
        // 停留 restarting + lastError（failed 需容器/守护层持续故障，见 0366 review 偏差）。
        await expect
            .poll(
                async () => {
                    const res = await request.get(
                        `${CP_URL}/api/v1/workspaces/${sharedWs}/mcp/servers`,
                        {
                            headers: sharedHeaders,
                        },
                    );
                    if (!res.ok()) return `http-${res.status()}`;
                    const body = (await res.json()) as { servers: Array<Record<string, unknown>> };
                    return body.servers
                        .map((s) => `${s.serverId}:${s.state}`)
                        .sort()
                        .join(",");
                },
                {
                    timeout: 120000,
                    intervals: [2000],
                    message: "stdio sessions settle to ready/restarting",
                },
            )
            .toBe("e2e-broken:restarting,e2e-stdio:ready");

        const snapshotRes = await request.get(
            `${CP_URL}/api/v1/workspaces/${sharedWs}/mcp/servers`,
            {
                headers: sharedHeaders,
            },
        );
        expect(snapshotRes.ok()).toBeTruthy();
        const snapshot = (await snapshotRes.json()) as {
            count: number;
            servers: Array<Record<string, unknown>>;
        };
        const stdio = snapshot.servers.find((s) => s.serverId === "e2e-stdio")!;
        const broken = snapshot.servers.find((s) => s.serverId === "e2e-broken")!;
        expect(Object.keys(stdio).sort()).toEqual([
            "attempt",
            "epoch",
            "lastError",
            "serverId",
            "sinceMs",
            "state",
        ]);
        expect(stdio.state).toBe("ready");
        expect(typeof stdio.sinceMs).toBe("number");
        expect(broken.state).toBe("restarting");
        expect(String(broken.lastError ?? "")).not.toBe("");
        expect(
            snapshot.servers.some((s) => s.serverId === "e2e-idle"),
            "a configured server without a session must be absent from the Runtime snapshot",
        ).toBe(false);
        expect(snapshot.count).toBe(snapshot.servers.length);

        // UI：设置页 workspace 标签 → 三行徽章（可用 / 失败+原因 / 无记录）
        seedPage(page, sharedAuth, sharedWs);
        await page.goto("/settings/config", { waitUntil: "load" });
        await page.getByTestId("config-tab-workspace").click();
        const panel = page.locator('[data-testid="mcp-servers-panel"]');
        await expect(panel).toBeVisible({ timeout: 20000 });
        const rows = panel.locator('[data-testid="mcp-server-row"]');
        await expect(rows).toHaveCount(3, { timeout: 30000 });

        const readyRow = rows.filter({ hasText: "e2e-stdio" });
        await expect(readyRow.locator('[data-testid="mcp-server-badge"]')).toHaveText(
            /可用|Ready/,
            { timeout: 30000 },
        );
        const brokenRow = rows.filter({ hasText: "e2e-broken" });
        await expect(brokenRow.locator('[data-testid="mcp-server-badge"]')).toHaveText(
            /重启中|Restarting/,
            { timeout: 30000 },
        );
        await expect(brokenRow.locator('[data-testid="mcp-server-reason"]')).not.toBeEmpty();
        const idleRow = rows.filter({ hasText: "e2e-idle" });
        await expect(idleRow.locator('[data-testid="mcp-server-badge"]')).toHaveText(
            /无记录|No session/,
        );

        await panel.scrollIntoViewIfNeeded();
        await expect(panel).toBeInViewport();
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "s1-stdio-badges-desktop.png"),
            fullPage: false,
        });
        await panel.screenshot({ path: path.join(EVIDENCE_DIR, "s1-mcp-panel-desktop.png") });
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(panel).toBeVisible();
        await panel.screenshot({ path: path.join(EVIDENCE_DIR, "s1-mcp-panel-mobile.png") });
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "s1-stdio-badges-mobile.png"),
            fullPage: false,
        });
        await page.setViewportSize({ width: 1280, height: 800 });
        console.log(`[plan0366] S1 evidence written to ${EVIDENCE_DIR}`);
    });

    test("S2/S4/S5: cancel one of two same-run jobs; the run and the other job survive; audit lands", async ({
        page,
        request,
    }) => {
        test.skip(
            LLM_MODE !== "job-cancel",
            "requires XIHE_E2E_LLM_MODE=job-cancel fake LLM marker mode",
        );
        // PLAN-0369: single-binding Agent — rebind before the workspace-tool chat.
        await ensureAgentWorkspaceBinding(sharedWs);
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        seedPage(page, sharedAuth, sharedWs);
        // cad8e727/0401 后 fresh workspace 无零会话 composer；直接进 beforeAll
        // bootstrap 出的会话路由（session-branch 同路径），chat-input 在会话路由渲染。
        await page.goto("/workspace/" + sharedWs + "/chat/" + suiteSessionId, {
            waitUntil: "load",
        });

        const chatInput = page.locator('[data-testid="chat-input"]');
        await expect(chatInput).toBeVisible({ timeout: 20000 });

        await chatInput.fill("XIHE-E2E-JOB-CANCEL start two jobs");
        await page.locator('[data-testid="chat-send-button"]').click();
        await approveUntil(page, "Two jobs started.");

        // 取会话并等 run 收尾（避免 CHAT_IN_PROGRESS 与重载竞态；PLAN-0464 起
        // run 终态以 `/chat/runs/{runId}` 为关联面）。
        const sessionId = await resolveSessionId(request);
        await awaitLatestChatRunTerminal(request, sessionId);

        // 重进会话路由：消息 DTO 带回 jobSummary（0344 口径；SSE 结束时卡片尚无档案）。
        // 工具调用会双份渲染（流式 parts + 持久化 tool-result 消息），且重载后 arguments
        // 不返回，因此用档案 jobId（面板可见）定位卡片，只取带 job-status 徽章的持久化卡。
        await page.goto("/workspace/" + sharedWs + "/chat/" + sessionId, {
            waitUntil: "load",
        });
        const summaries = await jobSummaries(request, sessionId);
        expect(summaries.length, "two same-run job archives").toBe(2);
        const targetJobId = summaries[0].jobId;
        const controlJobId = summaries[1].jobId;
        const toggles = page
            .locator('[data-testid="tool-card-toggle"]')
            .filter({ hasText: "start_background_process" });
        await expect(toggles.first()).toBeVisible({ timeout: 60000 });
        const toggleCount = await toggles.count();
        for (let i = 0; i < toggleCount; i += 1) {
            await toggles.nth(i).click();
        }
        const jobCards = page
            .locator('[data-testid="job-output-panel"]')
            .locator("..")
            .filter({ has: page.locator('[data-testid="job-status"]') });
        const cardA = jobCards.filter({ hasText: targetJobId }).last();
        const cardB = jobCards.filter({ hasText: controlJobId }).last();
        await expect(cardA.locator('[data-testid="job-status"]')).toHaveText(/运行中|Running/, {
            timeout: 30000,
        });
        await expect(cardB.locator('[data-testid="job-status"]')).toHaveText(/运行中|Running/, {
            timeout: 30000,
        });
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "s2-before-cancel.png"),
            fullPage: false,
        });

        // 取消 A：二次确认 → POST /cancel → 200 changed:true
        await cardA.locator('[data-testid="job-cancel-button"]').click();
        await expect(cardA.locator('[data-testid="job-cancel-confirm"]')).toBeVisible();
        await cardA.locator('[data-testid="job-cancel-confirm"]').click();
        const cancelResponse = await page.waitForResponse(
            (res) => res.url().includes("/cancel") && res.request().method() === "POST",
            { timeout: 60000 },
        );
        expect(cancelResponse.status(), `cancel failed: ${await cancelResponse.text()}`).toBe(200);
        const cancelBody = (await cancelResponse.json()) as {
            jobId: string;
            status: string;
            changed: boolean;
        };
        expect(cancelBody.status).toBe("cancelled");
        expect(cancelBody.changed).toBe(true);
        expect(cancelBody.jobId).toBe(targetJobId);

        // 可见结果：A 卡已取消；B 卡仍运行（同 run 其他 job 不受影响）
        await expect(cardA.locator('[data-testid="job-status"]')).toHaveText(/已取消|Cancelled/, {
            timeout: 30000,
        });
        await expect(cardA.locator('[data-testid="job-cancel-success"]')).toBeVisible();
        await expect(cardB.locator('[data-testid="job-status"]')).toHaveText(/运行中|Running/);
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "s2-after-cancel.png"),
            fullPage: false,
        });

        // 数据面：被取消的档案 cancelled；对照档案仍 running（续看端点的 jobStatus 即档案状态）
        const controlItem = summaries.find((job) => job.jobId !== cancelBody.jobId)!;
        expect(controlItem.jobId, "the other same-run job archive").toBe(controlJobId);
        const messagesAfter = await jobSummaries(request, sessionId);
        expect(
            messagesAfter.find((job) => job.jobId === cancelBody.jobId)?.status,
            "cancelled archive",
        ).toBe("cancelled");
        const controlOutput = await request.get(
            `${CP_URL}/api/v1/workspaces/${sharedWs}/jobs/${controlJobId}/output`,
            { headers: sharedHeaders },
        );
        expect(controlOutput.ok(), `control job-output ${controlOutput.status()}`).toBeTruthy();
        const controlChunk = (await controlOutput.json()) as { jobStatus: string };
        expect(controlChunk.jobStatus, "the other same-run job keeps running").toBe("running");

        // S3 未确认分支 UI 反馈：真实栈无法稳定复现「SIGKILL 后仍存活」→ 路由拦截 502
        // PLAN-0465 T2.1：UI cancel 走 canonical 路径 /workspaces/{ws}/jobs/{jobId}/cancel。
        await page.route("**/api/v1/workspaces/*/jobs/*/cancel", async (route) => {
            await route.fulfill({
                status: 502,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    type: "https://xihe.dev/problems/job_cancel_unconfirmed",
                    title: "Bad Gateway",
                    status: 502,
                    code: "JOB_CANCEL_UNCONFIRMED",
                    detail: "Job termination was not confirmed",
                    requestId: "e2e-0366",
                }),
            });
        });
        await cardB.locator('[data-testid="job-cancel-button"]').click();
        await cardB.locator('[data-testid="job-cancel-confirm"]').click();
        await expect(cardB.locator('[data-testid="job-cancel-error"]')).toHaveText(/取消未确认/, {
            timeout: 30000,
        });
        await expect(cardB.locator('[data-testid="job-status"]')).toHaveText(/运行中|Running/);
        await expect(cardB.locator('[data-testid="job-cancel-button"]')).toBeEnabled();
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "s3-cancel-unconfirmed.png"),
            fullPage: false,
        });
        await page.unroute("**/api/v1/workspaces/*/jobs/*/cancel");

        // S4 越权负例：无关用户一律 404（不泄露存在性）
        const otherEmail = `plan0366-other-${Date.now()}@test.com`;
        const otherReg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email: otherEmail, password: generateE2EPassword(), name: "Other" },
        });
        expect([200, 201]).toContain(otherReg.status());
        const otherToken = (await otherReg.json()).accessToken as string;
        // PLAN-0465 T2.1：canonical 路径的越权语义 = Workspace access 先判归属，
        // 无关用户一律 404（不泄露 Workspace/Job 存在性）。
        const foreign = await request.post(
            `${CP_URL}/api/v1/workspaces/${sharedWs}/jobs/${cancelBody.jobId}/cancel`,
            {
                headers: {
                    Authorization: `Bearer ${otherToken}`,
                    "Content-Type": "application/json",
                },
            },
        );
        expect(foreign.status()).toBe(404);
        expect(((await foreign.json()) as { code?: string }).code).toBe("WORKSPACE_NOT_FOUND");

        // run 继续：run 终态不是 cancelled（取消 job ≠ 取消 run）
        const finalRunStatus = await awaitLatestChatRunTerminal(request, sessionId);
        expect(finalRunStatus, "run survives the single-job cancel").not.toBe("cancelled");

        // S5 审计（PLAN-0465 T1.3 / PLAN-0462 decision #8）：domain transition
        // history 落 `workspace_job_history`——MCP 起的 Job 从 running 直接入域
        // （start 事件 to_status=running），取消产生 cancel 事件
        // （from=running → to=cancelled，cancel_reason=user_cancel）。
        const jobIdLiteral = String(cancelBody.jobId);
        const history = queryIsolatedPostgres(
            `SELECT event_type || '|' || COALESCE(from_status, '-') || '|' || to_status || '|' || COALESCE(cancel_reason, '-') FROM workspace_job_history WHERE job_id = '${jobIdLiteral}'::uuid ORDER BY sequence`,
        );
        const historyRows = history ? history.split("\n") : [];
        expect(historyRows, "domain history for the cancelled job").toContain("start|-|running|-");
        expect(historyRows).toContain("cancel|running|cancelled|user_cancel");

        const legacyResidue = queryIsolatedPostgres(
            "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' " +
                "AND table_name='workspace_jobs' AND column_name='operation_item_id'",
        );
        expect(legacyResidue).toBe("0");

        // 同会话继续对话（新 run）
        await chatInput.fill("continue after cancel");
        await page.locator('[data-testid="chat-send-button"]').click();
        await expect(page.getByText("Session continues after cancel.")).toBeVisible({
            timeout: 120000,
        });
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "s2-conversation-continues.png"),
            fullPage: false,
        });
        console.log(`[plan0366] S2/S3/S4/S5 evidence written to ${EVIDENCE_DIR}`);
    });
});

/**
 * cad8e727 后配置/agent 管理写需要显式 grant（与 session-branch 同模式）：
 * CREATE_ACCOUNT / CREATE_TEMPLATE / MANAGE_WORKSPACE_AGENTS。
 * 复制自 session-branch.spec.ts seedUserGrant（isolated runner 提供 PG fixture env）。
 */
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
