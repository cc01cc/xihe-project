// timeout-exempt: 8 个核心面逐面 boot + 3s 收敛窗口（task-844，LONG_TIMEOUT_MS 预算）。
/**
 * task-844（W2 / P0-1 增量）：1366×768 下核心面「页面根 + 代表性容器」双轴横向溢出。
 *
 * 与 `task753-1366-overflow.spec.ts` 的关系（不重复、不替代）：
 *   - task-753 判据：`document.scrollingElement.scrollWidth <= clientWidth + 1`，两档视口（1366/1920），
 *     只读**页面根**；其负例是临时探针，跑完即删。
 *   - 本 spec 判据：按合同 §3 原文 `document.documentElement.scrollWidth <= window.innerWidth`，
 *     且**每个面再读一个代表性容器**（`scrollWidth <= clientWidth + 1` 且无 `overflow-x: scroll`），
 *     并保留一条**入库反证**：测试内注入 6000px 探针后断言函数必须抛红。
 *
 * 覆盖合同 §3 的 8 个核心面：会话列表、聊天/composer、TO 指派、成员面板、设置（Provider/模型）、
 * 审批浮层、运行状态/错误态、登录/首装。仅 1366×768（1920 的页面根读数由 task-753 覆盖）。
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";
import { installApprovalSSE } from "./helpers/approval-sse";
import { pushMockApproval } from "./helpers/approval-registry";
import {
    assertFaceNoHorizontalOverflow,
    expectFaceNoHorizontalOverflow,
    readFaceOverflow,
} from "./helpers/face-overflow";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "task844-session";
const AGENT_PRINCIPAL_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

test.use({ viewport: { width: 1366, height: 768 } });

async function bootWorkspaceShell(page: Page): Promise<void> {
    await setupMockAuth(page);
    await setupMockSessions(page, {
        sessions: [{ id: SESSION_ID, title: "task844", agentPrincipalId: AGENT_PRINCIPAL_ID }],
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
                executionSpec: { status: "assigned", generation: 1, sandboxSpecHash: "task844" },
                runtime: { status: "ready", deviceId: "task844-device", lastHeartbeatAt: "now" },
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

test("① 会话列表：页面根 + 侧栏面板无横向溢出", async ({ page }) => {
    await bootWorkspaceShell(page);
    await page.goto(`/workspace/${WORKSPACE_ID}`);
    await expect(page.getByTestId("sidebar")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expectFaceNoHorizontalOverflow(page, "① 会话列表", '[data-testid="sidebar-panel"]');
});

test("② 聊天/composer：页面根 + 会话列/composer 无横向溢出", async ({ page }) => {
    await bootWorkspaceShell(page);
    await page.goto(`/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expectFaceNoHorizontalOverflow(page, "② 聊天/composer", '[data-testid="chat-composer"]');
    await expectFaceNoHorizontalOverflow(
        page,
        "② 聊天/会话列",
        '[data-testid="workspace-conversation"]',
    );
});

test("③ TO 指派：页面根 + 收件人行无横向溢出", async ({ page }) => {
    await bootWorkspaceShell(page);
    await setupMockParticipants(page, SESSION_ID);
    await page.goto(`/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`);
    await expect(page.getByTestId("to-targets-bar")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expectFaceNoHorizontalOverflow(page, "③ TO 指派", '[data-testid="to-targets-bar"]');
    await expectFaceNoHorizontalOverflow(
        page,
        "③ TO 收件人行",
        '[data-testid="composer-recipient-row"]',
    );
});

test("④ 成员面板：页面根 + 成员面板无横向溢出", async ({ page }) => {
    await bootWorkspaceShell(page);
    await serveMembersProjection(page);
    await page.goto(`/workspace/${WORKSPACE_ID}/members`);
    await expect(page.getByTestId("workspace-members-page")).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
    // 先落到数据态再采样：`ws-members-panel` 在 loading 骨架时也会渲染，过早采样会把
    // 「骨架恰好不溢出」当成成员面板的结论。此处桩返回空列表 ⇒ 等 empty 态出现。
    await expect(page.getByTestId("ws-members-empty")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expectFaceNoHorizontalOverflow(page, "④ 成员面板", '[data-testid="ws-members-panel"]');
});

test("⑤ 设置（Provider/模型）：页面根 + ProviderHub 无横向溢出", async ({ page }) => {
    await bootWorkspaceShell(page);
    await page.goto("/settings/user/llm-provider");
    await expect(page.getByTestId("provider-hub")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expectFaceNoHorizontalOverflow(page, "⑤ 设置", '[data-testid="provider-hub"]');
});

test("⑥ 审批浮层：页面根 + 浮层内容无横向溢出", async ({ page }) => {
    await bootWorkspaceShell(page);
    await serveApprovalDeps(page);
    await page.goto(`/workspace/${WORKSPACE_ID}/session/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await pushMockApproval(page, approvalEvent);
    await expect(page.getByTestId("modal-content")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
    await expectFaceNoHorizontalOverflow(page, "⑥ 审批浮层", '[data-testid="modal-content"]');
});

test("⑦ 运行状态：页面根 + 环境页区块无横向溢出", async ({ page }) => {
    await bootWorkspaceShell(page);
    await serveWorkspaceEnvironment(page);
    await page.goto(`/workspace/${WORKSPACE_ID}/environment`);
    await expect(page.getByTestId("workspace-environment-heading")).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
    // 环境页 heading 在 loading 前就存在；等到 status 卡渲染后再采样，读数才代表真实内容。
    await expect(page.getByTestId("workspace-environment-status")).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
    await expectFaceNoHorizontalOverflow(
        page,
        "⑦ 运行状态",
        'section:has([data-testid="workspace-environment-heading"])',
    );
});

test("⑧ 登录/首装：页面根 + 认证卡片无横向溢出", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("#identifier")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expectFaceNoHorizontalOverflow(page, "⑧ 登录", "main");

    await page.goto("/onboarding?firstRun=1");
    await expect(page.locator("main")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expect(page.locator("main button").first()).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expectFaceNoHorizontalOverflow(page, "⑧ 首装", "main");
});

// 反证：撑破容器后断言必须抛红（测试内注入，不提交产品改动）。
test("反证：测试内注入 6000px 探针后 guard 必须判红", async ({ page }) => {
    await page.goto("/login");
    await expect(page.locator("#identifier")).toBeVisible({ timeout: LONG_TIMEOUT_MS });

    // 注入前：干净态必须绿（否则反证没有参照物）。
    await expectFaceNoHorizontalOverflow(page, "反证-注入前", "main");

    await page.evaluate(() => {
        const host = document.querySelector("main");
        if (!host) throw new Error("反证宿主 main 不存在");
        const probe = document.createElement("div");
        probe.setAttribute("data-testid", "task844-overflow-probe");
        // 必须是**流内**子元素：绝对定位子元素只计入其包含块（视口）的滚动溢出，
        // 不会进入 `main` 自己的 scrollWidth（首版就是这么假绿的）。
        probe.style.cssText =
            "display:block;flex:0 0 auto;width:6000px;min-width:6000px;height:4px;pointer-events:none;";
        host.appendChild(probe);
    });

    const broken = await readFaceOverflow(page, "main");
    const docBroken = broken.docScrollWidth > broken.innerWidth;
    const containerBroken =
        broken.container !== null &&
        broken.container.scrollWidth > broken.container.clientWidth + 1;
    expect(
        docBroken || containerBroken,
        `反证本身无效：注入 6000px 探针后读数仍未越过阈值` +
            `（documentElement.scrollWidth=${broken.docScrollWidth} window.innerWidth=${broken.innerWidth}` +
            `，container=${broken.container?.scrollWidth}/${broken.container?.clientWidth}）`,
    ).toBe(true);

    let rejected: unknown = null;
    try {
        assertFaceNoHorizontalOverflow(broken, "反证-注入后");
    } catch (error) {
        rejected = error;
    }
    expect(rejected, "反证失败：容器被撑破后 guard 仍判绿").not.toBeNull();
});
