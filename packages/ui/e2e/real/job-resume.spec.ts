import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { generateE2EPassword } from "./helpers/password";
import { ensureAgentWorkspaceBinding, getRootBranchId } from "./helpers/journey";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || "12631"}`;
const LLM_MODE = process.env.XIHE_E2E_LLM_MODE ?? "mock";
const EVIDENCE_DIR = path.resolve(process.cwd(), "../../.local/evidence/job-resume");

function waitForChatEventStream(page: Page, sessionId: string) {
    return page.waitForResponse(
        (response) => {
            const url = new URL(response.url());
            return (
                url.pathname === "/api/v1/events" &&
                url.searchParams.get("sessionId") === sessionId &&
                response.status() === 200
            );
        },
        { timeout: 30000 },
    );
}

async function waitForControlPlaneAgentReady(
    request: APIRequestContext,
    headers: Record<string, string>,
) {
    await expect
        .poll(
            async () => {
                const response = await request.get(`${CP_URL}/api/v1/status`, { headers });
                if (!response.ok()) return `HTTP ${response.status()}`;
                const body = (await response.json()) as {
                    services?: Array<{ key: string; status?: string; llmReady?: string }>;
                };
                const agent = body.services?.find((service) => service.key === "agent");
                return agent ? `${agent.status}/${agent.llmReady}` : "agent-status-missing";
            },
            { timeout: 30000, intervals: [250, 500, 1000] },
        )
        .toBe("up/ready");
}

// PLAN-0344 T1.4c：durable job 的真实 host 证据。
// 链路：workspace 会话发起 start_background_process（审批）→ 刷新后 job 卡片
// 从 messages DTO jobSummary 重建（PLAN-0465 decision #7 键位 = domain jobId，
// canonical 路由 /workspaces/{ws}/jobs/{jobId}/output）→ 按字节游标续看真实
// 容器输出 → destroy workspace → 访问边界收敛 404 WORKSPACE_NOT_FOUND
//（409 LOST/EXPIRED 区分在 Workspace 存活期可观察，由 plan0390 覆盖）。
// 需要确定性 fake LLM 标记模式：
//   node scripts/e2e-host.mjs --retries=0 e2e/real/job-resume.spec.ts --llm-mode=job
test.describe("@host PLAN-0344 durable job resume", () => {
    test.describe.configure({ mode: "serial" });
    test.setTimeout(240000);

    // PLAN-290 约束：Agent 每进程只绑定一个 workspace，测试共享同一注册用户/工作区。
    let sharedAuth: string, sharedWs: string, sharedHeaders: Record<string, string>;
    /** cad8e727 后会话必须挂 agentPrincipalId：套件级 bootstrap 出的共享会话。 */
    let suiteSessionId = "";

    test.beforeAll(async ({ request }) => {
        const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword();
        const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
            data: { email: `job-resume-${Date.now()}@test.com`, password, name: "JobResume" },
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

        // PLAN-0465 T3.2 调整（与 plan0366 同模式，cad8e727/0401 IA 后 fresh
        // workspace 无零会话 composer）：grants → 模板 → principal → binding → 会话。
        const bootHeaders = { ...sharedHeaders, "X-Workspace-Id": sharedWs };
        const me = await request.get(`${CP_URL}/api/v1/auth/me`, { headers: bootHeaders });
        expect(me.ok(), await me.text()).toBeTruthy();
        const userId = ((await me.json()) as { id: string }).id;
        seedUserGrant(userId, sharedWs);

        const roleId = randomUUID(),
            templateId = randomUUID();
        const rolePermissions = [
            { actionClass: "read", resource: "*" },
            { actionClass: "write", resource: "*" },
            { actionClass: "exec", resource: "*" },
        ];
        const templateWrite = await request.put(`${CP_URL}/api/v1/config/user/agent-templates`, {
            headers: bootHeaders,
            data: {
                roles: JSON.stringify([
                    { id: roleId, name: "JobResume Role", permissions: rolePermissions },
                ]),
                templates: JSON.stringify([
                    {
                        id: templateId,
                        name: "JobResume Agent",
                        description: "Workspace-bound host fixture for durable job resume",
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
            data: { name: "JobResume Agent", templateId },
        });
        expect(principalRes.status(), await principalRes.text()).toBe(201);
        const principalId = ((await principalRes.json()) as { principalId: string }).principalId;
        const binding = await request.put(
            `${CP_URL}/api/v1/workspaces/${sharedWs}/agents/${principalId}`,
            { headers: bootHeaders, data: { permissions: rolePermissions } },
        );
        expect(binding.status(), await binding.text()).toBe(200);

        const sessionRes = await request.post(`${CP_URL}/api/v1/sessions`, {
            headers: bootHeaders,
            data: { title: "Job resume session", agentPrincipalId: principalId },
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
    }

    test("@host PLAN-0464 stops a pending-approval ChatRun from the browser", async ({
        page,
        request,
    }) => {
        test.skip(LLM_MODE !== "job", "requires XIHE_E2E_LLM_MODE=job fake LLM marker mode");
        await ensureAgentWorkspaceBinding(sharedWs);
        await waitForControlPlaneAgentReady(request, sharedHeaders);
        seedPage(page, sharedAuth, sharedWs);
        const eventStream = waitForChatEventStream(page, suiteSessionId);
        await page.goto("/workspace/" + sharedWs + "/chat/" + suiteSessionId, {
            waitUntil: "load",
        });
        expect((await eventStream).status()).toBe(200);

        const chatInput = page.locator('[data-testid="chat-input"]');
        const modal = page.locator('[data-testid="modal-content"]');
        await expect(chatInput).toBeVisible({ timeout: 20000 });

        const submission = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return url.pathname === "/api/v1/chat" && response.request().method() === "POST";
        });
        await chatInput.fill("XIHE-E2E-JOB cancel while approval is pending");
        await page.getByTestId("chat-send-button").click();
        const submitResponse = await submission;
        expect(submitResponse.status()).toBe(202);
        const runId = ((await submitResponse.json()) as { runId: string }).runId;

        await expect(modal, "the fake job tool must reach its user approval gate").toBeVisible({
            timeout: 120000,
        });
        await expect(page.getByTestId("chat-stop-button")).toBeVisible();
        await page.getByTestId("modal-content").getByRole("button", { name: "Close" }).click();
        await expect(modal).toBeHidden();
        await expect(page.getByTestId("pending-approval-reopen-pill")).toBeVisible();

        const cancelResponse = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
                url.pathname === `/api/v1/chat/runs/${runId}/cancel` &&
                response.request().method() === "POST"
            );
        });
        await page.getByTestId("chat-stop-button").click();
        const response = await cancelResponse;
        expect(response.status()).toBe(200);
        expect(await response.json()).toMatchObject({ status: "cancel_accepted", runId });

        await expect(modal).toBeHidden({ timeout: 15000 });
        await expect(page.getByTestId("pending-approval-reopen-pill")).toHaveCount(0);
        await expect(page.getByTestId("session-pending-badge")).toHaveCount(0);
        await expect(page.getByTestId("chat-send-button")).toBeVisible();
        await expect(page.getByTestId("chat-stop-button")).toHaveCount(0);

        await expect
            .poll(
                async () => {
                    const result = await page.request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, {
                        headers: sharedHeaders,
                    });
                    if (!result.ok()) return `HTTP ${result.status()}`;
                    const body = (await result.json()) as { status: string };
                    return body.status;
                },
                { timeout: 15000, intervals: [200, 500, 1000] },
            )
            .toBe("cancelled");
        const finalRun = await page.request.get(`${CP_URL}/api/v1/chat/runs/${runId}`, {
            headers: sharedHeaders,
        });
        expect(finalRun.ok()).toBeTruthy();
        expect(await finalRun.json()).toMatchObject({ status: "cancelled", pendingApprovals: [] });

        mkdirSync(EVIDENCE_DIR, { recursive: true });
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "chat-run-cancelled-from-browser.png"),
            fullPage: false,
        });
    });

    test("job card survives refresh, resumes output, and denies access after destroy", async ({
        page,
        request,
    }) => {
        test.skip(LLM_MODE !== "job", "requires XIHE_E2E_LLM_MODE=job fake LLM marker mode");
        // PLAN-0369: single-binding Agent — rebind before the workspace-tool chat.
        await ensureAgentWorkspaceBinding(sharedWs);
        await waitForControlPlaneAgentReady(request, sharedHeaders);
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        seedPage(page, sharedAuth, sharedWs);
        const eventStream = waitForChatEventStream(page, suiteSessionId);
        // cad8e727/0401 后 fresh workspace 无零会话 composer；直接进 beforeAll
        // bootstrap 出的会话路由（session-branch 同路径）。
        await page.goto("/workspace/" + sharedWs + "/chat/" + suiteSessionId, {
            waitUntil: "load",
        });
        expect((await eventStream).status()).toBe(200);

        const chatInput = page.locator('[data-testid="chat-input"]');
        await expect(chatInput).toBeVisible({ timeout: 20000 });
        const modal = page.locator('[data-testid="modal-content"]');

        await chatInput.fill("XIHE-E2E-JOB start the durable job");
        await page.locator('[data-testid="chat-send-button"]').click();

        // start_background_process 走审批门禁（REQUIRE_APPROVAL）
        await expect(modal, "approval modal for start_background_process").toBeVisible({
            timeout: 120000,
        });
        await modal.locator('[data-testid="approval-approve"]').click();
        await expect(modal).toBeHidden({ timeout: 20000 });

        // follow-up 流结束（run 收尾）后再刷新，避免半态
        await expect(page.getByText("Background job started.")).toBeVisible({ timeout: 60000 });
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "job-started-live.png"),
            fullPage: false,
        });

        // 刷新恢复：整页重载后重新进入 Workspace 会话。workspace 视图重载后
        // 默认落在文件树，不承载聊天面板；卡片只能从 messages DTO 的 jobSummary
        // 重建（tool_result 不持久化）——这里同时以 API 断言该数据源存在。
        const sessionsRes = await page.request.get(`${CP_URL}/api/v1/sessions`, {
            headers: sharedHeaders,
        });
        expect(sessionsRes.ok(), `sessions list ${sessionsRes.status()}`).toBeTruthy();
        const sessions = (await sessionsRes.json()) as { sessions?: Array<{ id: string }> };
        const sessionId = sessions.sessions?.[0]?.id;
        if (!sessionId) throw new Error("session created by the workspace chat was not listed");
        const branchId = await getRootBranchId(page.request, sessionId, sharedHeaders);
        const messagesRes = await page.request.get(
            `${CP_URL}/api/v1/sessions/${sessionId}/messages?branchId=${branchId}`,
            {
                headers: sharedHeaders,
            },
        );
        expect(messagesRes.ok(), `messages ${messagesRes.status()}`).toBeTruthy();
        const messages = (await messagesRes.json()) as Array<{
            jobSummary?: Array<{
                jobId?: string;
                workspaceId?: string;
                toolName?: string;
            }>;
        }>;
        const summary = messages
            .flatMap((message) => message.jobSummary ?? [])
            .find((job) => job.toolName === "start_background_process");
        // PLAN-0465 decision #7：jobSummary 身份 = domain jobId（itemId 已移除）。
        expect(summary?.jobId, "jobSummary archived in the messages DTO").toBeTruthy();
        const jobId = summary?.jobId ?? "",
            jobWorkspaceId = summary?.workspaceId ?? sharedWs;

        await page.goto("/workspace/" + sharedWs + "/chat/" + sessionId, { waitUntil: "load" });
        const card = page
            .locator('[data-testid="tool-card-toggle"]')
            .filter({ hasText: "start_background_process" })
            .first();
        await expect(card, "job card restored from jobSummary after reload").toBeVisible({
            timeout: 60000,
        });
        await card.click();

        const panel = page.locator('[data-testid="job-output-panel"]');
        await expect(panel).toBeVisible({ timeout: 20000 });
        await panel.locator('[data-testid="job-output-load"]').click();
        const output = panel.locator('[data-testid="job-output-data"]');
        await expect(output).toContainText("job-line-1", { timeout: 30000 });
        await expect(output).toContainText("job-line-2");
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "resume-after-reload.png"),
            fullPage: false,
        });

        // destroy workspace：Runtime destroying 窗口枚举存活 job → 档案落 orphaned
        const del = await page.request.delete(`${CP_URL}/api/v1/workspaces/${sharedWs}`, {
            headers: sharedHeaders,
        });
        expect([200, 202, 204], `destroy failed: ${del.status()} ${await del.text()}`).toContain(
            del.status(),
        );

        // PLAN-0465（访问边界与 plan0390 listAfterDestroy 同判据）：destroy 后
        // requireActiveWorkspace 先判 Workspace 存在性 → canonical 输出路由
        // 404 WORKSPACE_NOT_FOUND. 409 LOST/EXPIRED 的区分只在
        // Workspace 存活期可观察——该能力由 plan0390 覆盖（容器内 job 目录删除 →
        // 409 JOB_OUTPUT_LOST；沙盒移除 → 503 RUNTIME_ERROR）。
        const outputPath = `${CP_URL}/api/v1/workspaces/${jobWorkspaceId}/jobs/${jobId}/output`;
        await expect
            .poll(
                async () => {
                    const res = await page.request.get(outputPath, {
                        headers: sharedHeaders,
                    });
                    return res.status();
                },
                { timeout: 90000, message: "job-output denies with 404 after destroy" },
            )
            .toBe(404);
        const deniedBody = (await (
            await page.request.get(outputPath, {
                headers: sharedHeaders,
            })
        ).json()) as { code?: string };
        expect(deniedBody.code, "destroyed workspace collapses to access denial").toBe(
            "WORKSPACE_NOT_FOUND",
        );

        // UI 层显式提示（不刷新，保持 DOM 在场）
        await panel.locator('[data-testid="job-output-load"]').click();
        const error = panel.locator('[data-testid="job-output-error"]');
        await expect(error).toBeVisible({ timeout: 30000 });
        await expect(error).toContainText(/not found|未找到|不存在/i);
        await page.screenshot({
            path: path.join(EVIDENCE_DIR, "destroy-denied.png"),
            fullPage: false,
        });
        console.log(`[job-resume] evidence written to ${EVIDENCE_DIR}`);
    });
});

/**
 * cad8e727 后配置/agent 管理写需要显式 grant（复制自 session-branch.spec.ts）：
 * CREATE_ACCOUNT / CREATE_TEMPLATE / MANAGE_WORKSPACE_AGENTS。
 */
function seedUserGrant(userId: string, workspaceId: string) {
    const container = process.env.XIHE_E2E_PG_CONTAINER,
        database = process.env.XIHE_E2E_PG_DATABASE;
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
