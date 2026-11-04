/**
 * PLAN-0658 M4：工作区三角色渲染矩阵（mock lane，无栈）。
 *
 * 覆盖清单（T1.3）：
 *  - OWNER：工作区设置页可见「成员」tab 与管理动作区；
 *  - VIEWER：**不渲染**成员 tab（`canViewMembers` 过滤），管理动作区不出现；
 *  - 只读角色仍能进入 chat 面（composer 可用，不被角色门误伤）。
 *
 * 角色来源：`setupMockAuth` 的会话上下文种子（sessionStorage xh-workspace 的
 * workspaceRole；auth store 由它派生 canViewMembers/canManageWorkspace）。
 */
import { test, expect, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";

const WORKSPACE_ID = "workspace-1";

async function openSettings(page: Page): Promise<void> {
    await page.goto(`/workspace/${WORKSPACE_ID}/settings`);
    await expect(page.getByTestId("workspace-settings-page"), "settings page mounts").toBeVisible({
        timeout: 15_000,
    });
}

test.describe("会话矩阵 M4 — 三角色渲染", () => {
    test("OWNER：成员 tab 与管理动作区可见", async ({ page }) => {
        await setupMockAuth(page); // 默认 workspaceRole = OWNER
        await setupMockSessions(page, { sessions: [] });
        await openSettings(page);
        await expect(
            page.getByTestId("ws-settings-tab-members"),
            "members tab visible for OWNER",
        ).toBeVisible({ timeout: 10_000 });
        await expect(
            page.getByTestId("ws-settings-edit"),
            "manage block visible for OWNER",
        ).toBeVisible();
    });

    test("VIEWER：成员 tab 不渲染，管理动作区不出现", async ({ page }) => {
        await setupMockAuth(page, { workspace: { workspaceRole: "VIEWER" } });
        await setupMockSessions(page, { sessions: [] });
        await openSettings(page);
        await expect(
            page.getByTestId("ws-settings-tab-members"),
            "VIEWER must not see the members tab",
        ).toHaveCount(0);
        await expect(
            page.getByTestId("ws-settings-edit"),
            "VIEWER has no manage block",
        ).toHaveCount(0);
    });

    test("VIEWER 仍能进入 chat 面（角色门不误伤只读用户）", async ({ page }) => {
        await setupMockAuth(page, { workspace: { workspaceRole: "VIEWER" } });
        await setupMockSessions(page, {
            sessions: [{ id: "viewer-session", title: "Viewer Chat" }],
        });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/viewer-session`);
        await expect(page.getByTestId("chat-input"), "composer available for VIEWER").toBeVisible({
            timeout: 15_000,
        });
    });
});
