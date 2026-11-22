// timeout-exempt: 8 个核心面 × 2 档视口，逐面 boot（LONG_TIMEOUT_MS 25 s 预算）。
/**
 * task-753（W2 / P0-1）：合同 §3「1366×768 与 1920×1080 无横向滚动」的机械断言。
 *
 * 判据：`document.scrollingElement.scrollWidth <= clientWidth + 1`（见 helpers/overflow-guard.ts）。
 * 覆盖合同列出的 8 个核心面：
 *   ① 会话列表 ② 聊天/composer ③ TO 指派 ④ 成员面板
 *   ⑤ 设置（Provider/模型） ⑥ 审批浮层 ⑦ 运行状态/错误态 ⑧ 首装/登录
 *
 * 复用现有 mock 车道（helpers/auth、mock-test 失败门禁、approval/workspace 夹具），不另起体系。
 * 负例「红」证明见临时探针 `__task753_overflow_probe.spec.ts`（跑完即删，读数落 evidence）。
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";
import { installApprovalSSE } from "./helpers/approval-sse";
import { pushMockApproval } from "./helpers/approval-registry";
import { expectNoDocHorizontalOverflow } from "./helpers/overflow-guard";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task753-session";
const AGENT_PRINCIPAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

const VIEWPORTS = [
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
] as const;

async function bootWorkspaceShell(page: Page): Promise<void> {
    await setupMockAuth(page);
    await setupMockSessions(page, {
        sessions: [{ id: SESSION_ID, title: "task753", agentPrincipalId: AGENT_PRINCIPAL_ID }],
        workspaceId: WORKSPACE_ID,
    });
}

async function serveMembersProjection(page: Page): Promise<void> {
    await page.route("**/api/v1/me/permissions", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                userId: "user-1",
                instanceCapabilities: [],
                instancePermissions: [],
                workspaces: [
                    {
                        workspaceId: WORKSPACE_ID,
                        workspaceRole: "OWNER",
                        workspaceAdmin: true,
                        permissions: ["WRITE_WORKSPACE_CONTENT"],
                    },
                ],
            }),
        }),
    );
    await page.route(`**/api/v1/workspaces/${WORKSPACE_ID}/members**`, (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([]),
        }),
    );
}

async function serveWorkspaceEnvironment(page: Page): Promise<void> {
    await page.route("**/api/v1/workspaces/*/environment", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                workspaceId: WORKSPACE_ID,
                status: "ready",
                storageBackend: "host_directory",
                storageRef: WORKSPACE_ID,
                executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "task753" },
                runtime: { status: "ready", deviceId: "task753-device", lastHeartbeatAt: "now" },
            }),
        }),
    );
}

async function serveApprovalDeps(page: Page): Promise<void> {
    await page.route("**/api/v1/policy/mode*", (route) => {
        const url = new URL(route.request().url());
        const sessionId = url.searchParams.get("sessionId") ?? SESSION_ID;
        void route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ sessionId, mode: "manual", sessionRules: 0 }),
        });
    });
    await installApprovalSSE(page, { sessionId: SESSION_ID, runId: RUN_ID });
}

const approvalEvent = {
    requestId: REQUEST_ID,
    runId: RUN_ID,
    sessionId: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    tool: "request_approval",
    action: "delete file",
    details: "workspace/README.md",
    argumentsHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    state: "pending",
    replayed: false,
    policy: {
        effect: "ask",
        sourceLayer: "workspace",
        matchedRule: null,
        reason: "No matching allow rule",
        mode: "manual",
        actionClass: "delete",
        shape: "structured",
    },
};

for (const size of VIEWPORTS) {
    test.describe(`task-753 ${size.width}×${size.height} 核心面无横向溢出`, () => {
        test.use({ viewport: { width: size.width, height: size.height } });

        test("① 会话列表 / 工作区外壳", async ({ page }) => {
            await bootWorkspaceShell(page);
            await page.goto(`/workspace/${WORKSPACE_ID}`);
            await expect(page.getByTestId("sidebar")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await expectNoDocHorizontalOverflow(page, `① 会话列表 @${size.width}`);
        });

        test("② 聊天 / composer", async ({ page }) => {
            await bootWorkspaceShell(page);
            await page.goto(`/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`);
            await expect(page.getByTestId("chat-input")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await expectNoDocHorizontalOverflow(page, `② 聊天/composer @${size.width}`);
        });

        test("③ TO 指派（发送栏）", async ({ page }) => {
            await bootWorkspaceShell(page);
            await setupMockParticipants(page, SESSION_ID);
            await page.goto(`/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`);
            // task-9（DSD-1458）：原「代发身份」speak-as 栏已并入收件人行，TO 多选在
            // `to-targets-bar`（RecipientField），外层行恒为 `composer-recipient-row`。
            await expect(page.getByTestId("to-targets-bar")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await expectNoDocHorizontalOverflow(page, `③ TO 指派 @${size.width}`);
        });

        test("④ 成员面板", async ({ page }) => {
            await bootWorkspaceShell(page);
            await serveMembersProjection(page);
            await page.goto(`/workspace/${WORKSPACE_ID}/members`);
            await expect(page.getByTestId("workspace-members-page")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await expectNoDocHorizontalOverflow(page, `④ 成员面板 @${size.width}`);
        });

        test("⑤ 设置（Provider/模型）", async ({ page }) => {
            await bootWorkspaceShell(page);
            await page.goto("/settings/user/llm-provider");
            await expect(page.getByTestId("provider-hub")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await expectNoDocHorizontalOverflow(page, `⑤ 设置 Provider/模型 @${size.width}`);
        });

        test("⑥ 审批浮层", async ({ page }) => {
            await bootWorkspaceShell(page);
            await serveApprovalDeps(page);
            await page.goto(`/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`);
            await expect(page.getByTestId("chat-input")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await pushMockApproval(page, approvalEvent);
            await expect(page.getByTestId("modal-content")).toBeVisible({
                timeout: EXPECT_TIMEOUT_MS,
            });
            await expectNoDocHorizontalOverflow(page, `⑥ 审批浮层 @${size.width}`);
        });

        test("⑦ 运行状态 / 环境", async ({ page }) => {
            await bootWorkspaceShell(page);
            await serveWorkspaceEnvironment(page);
            await page.goto(`/workspace/${WORKSPACE_ID}/environment`);
            await expect(page.getByTestId("workspace-environment-heading")).toBeVisible({
                timeout: LONG_TIMEOUT_MS,
            });
            await expectNoDocHorizontalOverflow(page, `⑦ 运行状态 @${size.width}`);
        });

        test("⑧ 首装 / 登录", async ({ page }) => {
            await page.goto("/login");
            await expect(page.locator("#identifier")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
            await expectNoDocHorizontalOverflow(page, `⑧ 登录 @${size.width}`);
        });
    });
}
