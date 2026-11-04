/**
 * PLAN-0659 T1.4：**委派 DAG 面板**的真浏览器证据（mock 车道，无后端）。
 *
 * 覆盖 V4 判据的运行态：
 *  - 右栏 dock 有「委派」tab，工具栏按钮能打开它；
 *  - 父会话 + 两个 SPAWN 子会话 ⇒ 3 节点 / 2 条 SVG 边，`data-depth` 0/1/1；
 *  - 子会话状态来自父会话 derived-state（运行中 / 成功），根节点显示 delegation-usage 预算；
 *  - 空态：普通会话没有委派子会话时不画图。
 *
 * 数据全部走现有投影接口（sessions 列表 + derived-state + delegation-usage），
 * 不新造 wire —— 图是 UI 投影，不是新的持久化面。
 */
import { test, expect, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";
import { captureEvidence } from "../helpers/evidence";
import { closeMonitorDockTab, openMockSession } from "./helpers/plan0659";

const SESSION_ID = "test-session";
const CHILD_A = "aaaaaaaa-1111-4222-8333-444444444444";
const CHILD_B = "bbbbbbbb-1111-4222-8333-444444444444";

/** `setupMockSessions` 不透传 kind/spawnedFromSessionId，委派 lineage 需要自己的 sessions 桩。 */
async function stubDelegationSessions(page: Page): Promise<void> {
    const now = "2026-11-04T10:00:00.000Z";
    // 会话列表有两条等价入口（旧 `/sessions` 与 PLAN-0608 的 workspace 寻址路径），都要拦。
    await page.route(/\/api\/v1\/(?:workspaces\/[^/]+\/)?sessions(?:\?.*)?$/, async (route) => {
        if (route.request().method() !== "GET") {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessions: [
                    {
                        id: SESSION_ID,
                        title: "委派根会话",
                        createdAt: now,
                        updatedAt: now,
                        workspaceId: "workspace-1",
                        kind: null,
                        spawnedFromSessionId: null,
                        spawnedAt: null,
                        agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
                        archived: false,
                    },
                    {
                        id: CHILD_A,
                        title: "子会话 A",
                        createdAt: now,
                        updatedAt: now,
                        workspaceId: "workspace-1",
                        kind: "SPAWN",
                        spawnedFromSessionId: SESSION_ID,
                        spawnedAt: "2026-11-04T10:01:00.000Z",
                        agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
                        archived: false,
                    },
                    {
                        id: CHILD_B,
                        title: "子会话 B",
                        createdAt: now,
                        updatedAt: now,
                        workspaceId: "workspace-1",
                        kind: "SPAWN",
                        spawnedFromSessionId: SESSION_ID,
                        spawnedAt: "2026-11-04T10:02:00.000Z",
                        agentPrincipalId: "00000000-0000-4000-8000-0000000000a1",
                        archived: false,
                    },
                ],
            }),
        });
    });
}

async function stubDelegationProjections(page: Page): Promise<void> {
    await page.route(`**/api/v1/sessions/${SESSION_ID}/derived-state`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                sessionId: SESSION_ID,
                activeChildren: [
                    {
                        childSessionId: CHILD_A,
                        runId: "run-a",
                        name: "子会话 A",
                        status: "running",
                    },
                ],
                terminalNotices: [
                    {
                        childSessionId: CHILD_B,
                        runId: "run-b",
                        name: "子会话 B",
                        state: "success",
                        terminalAt: "2026-11-04T10:03:00.000Z",
                    },
                ],
            }),
        });
    });
    await page.route(`**/api/v1/sessions/${SESSION_ID}/delegation-usage`, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                rootSessionId: SESSION_ID,
                usedSessions: 2,
                maxCount: 5,
                currentDepth: 0,
                maxDepth: 3,
                principalId: null,
                principalName: "Agent Alpha",
                policySource: "subject",
                disabled: false,
            }),
        });
    });
}

test.describe("PLAN-0659 T1.4 — 委派 DAG", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "委派根会话" }] });
        await stubDelegationSessions(page);
        await setupMockParticipants(page, SESSION_ID);
        await stubDelegationProjections(page);
    });

    test("父→子 3 节点 2 边 + 子状态 + 根预算；工具栏可打开面板", async ({ page }) => {
        await openMockSession(page, SESSION_ID);
        await closeMonitorDockTab(page);

        // 工具栏入口（与 monitor/members 同构）。
        const toggle = page.getByTestId("workspace-toolbar-delegation");
        await expect(toggle).toHaveAttribute("aria-pressed", "false");
        await toggle.click();
        await expect(page.getByTestId("dock-tab-delegation")).toBeVisible({ timeout: 10_000 });
        await expect(toggle).toHaveAttribute("aria-pressed", "true");

        const panel = page.getByTestId("delegation-dag");
        await expect(panel).toBeVisible({ timeout: 10_000 });

        const nodes = page.getByTestId("delegation-node");
        await expect(nodes, "root + 2 children").toHaveCount(3, { timeout: 10_000 });
        await expect(nodes.nth(0)).toHaveAttribute("data-session-id", SESSION_ID);
        await expect(nodes.nth(1)).toHaveAttribute("data-session-id", CHILD_A);
        await expect(nodes.nth(2)).toHaveAttribute("data-session-id", CHILD_B);
        await expect(nodes.nth(0)).toHaveAttribute("data-depth", "0");
        await expect(nodes.nth(1)).toHaveAttribute("data-depth", "1");
        await expect(nodes.nth(2)).toHaveAttribute("data-depth", "1");
        await expect(page.getByTestId("delegation-edge"), "two SVG edges").toHaveCount(2);

        // 子状态来自父会话 derived-state：在途 / 终态各一（DOM 断言面认 data-*）。
        await expect(nodes.nth(1)).toHaveAttribute("data-node-active", "true");
        await expect(nodes.nth(2)).toHaveAttribute("data-node-terminal", "success");
        const statuses = page.getByTestId("delegation-node-status");
        await expect(statuses.nth(0)).toHaveText("运行中");
        await expect(statuses.nth(1)).toHaveText("成功");

        // 根预算 = delegation-usage 投影。
        await expect(page.getByTestId("delegation-budget")).toHaveText("预算 2/5 · 深度 0/3");
        await expect(page.getByTestId("delegation-dag-empty")).toHaveCount(0);

        await captureEvidence(page, "t1.4-delegation-dag");
    });
});
