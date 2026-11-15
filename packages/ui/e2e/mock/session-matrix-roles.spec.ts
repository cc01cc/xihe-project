// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
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
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { ACTION_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

async function openSettings(page: Page): Promise<void> {
    await page.goto(`/workspace/${WORKSPACE_ID}/settings`);
    await expect(page.getByTestId("workspace-settings-page"), "settings page mounts").toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}

test.describe("会话矩阵 M4 — 三角色渲染", () => {
    test("OWNER：一级成员页可见，设置页管理动作区可见", async ({ page }) => {
        await setupMockAuth(page); // 默认 workspaceRole = OWNER
        await setupMockSessions(page, { sessions: [] });
        // task-236（M4-3）：成员提升为一级页 —— OWNER 在 /members 看到成员面板本体。
        await page.goto(`/workspace/${WORKSPACE_ID}/members`);
        await expect(
            page.getByTestId("workspace-members-page"),
            "members page visible for OWNER",
        ).toBeVisible({ timeout: ACTION_TIMEOUT_MS });
        await expect(page.getByTestId("ws-members-panel")).toBeVisible();
        await openSettings(page);
        await expect(
            page.getByTestId("ws-settings-edit"),
            "manage block visible for OWNER",
        ).toBeVisible();
    });

    test("VIEWER：成员页不渲染成员列表，管理动作区不出现", async ({ page }) => {
        // task-163：`workspace` 是 seed 字段，管不到 /me/permissions（那里此前恒 WS_OWNER）
        // ⇒ 必须同时给 workspaceRole/workspaceAdmin，否则 VIEWER 用例拿到的仍是 OWNER。
        // task-176：VIEWER 必须**成组**表达 —— 单点压 `workspaceRole`/`workspaceAdmin` 挡不住
        // `canWorkspaceAdmin` 的第一条短路（`isAdmin` = `capabilities.isInstanceAdmin`，夹具默认 true），
        // 而清空 caps 又会踩 `workspaceAdminOf` 缺失。`viewer` 预设三处同时自洽。
        await setupMockAuth(page, {
            workspace: { workspaceRole: "VIEWER" },
            capabilitiesPreset: "viewer",
        });
        await setupMockSessions(page, { sessions: [] });
        // task-236（M4-3）：设置页无成员 tab、无管理动作区；直进成员页也不渲染列表（不发明 403 页）。
        await openSettings(page);
        await expect(
            page.getByTestId("ws-settings-tab-members"),
            "VIEWER must not see a settings members tab",
        ).toHaveCount(0);
        await expect(
            page.getByTestId("ws-settings-edit"),
            "VIEWER has no manage block",
        ).toHaveCount(0);
        await page.goto(`/workspace/${WORKSPACE_ID}/members`);
        await expect(
            page.getByTestId("ws-members-panel"),
            "VIEWER must not see the members panel",
        ).toHaveCount(0);
    });

    test("VIEWER 仍能进入 chat 面（角色门不误伤只读用户）", async ({ page }) => {
        // task-163：`workspace` 是 seed 字段，管不到 /me/permissions（那里此前恒 WS_OWNER）
        // ⇒ 必须同时给 workspaceRole/workspaceAdmin，否则 VIEWER 用例拿到的仍是 OWNER。
        // task-176：VIEWER 必须**成组**表达 —— 单点压 `workspaceRole`/`workspaceAdmin` 挡不住
        // `canWorkspaceAdmin` 的第一条短路（`isAdmin` = `capabilities.isInstanceAdmin`，夹具默认 true），
        // 而清空 caps 又会踩 `workspaceAdminOf` 缺失。`viewer` 预设三处同时自洽。
        await setupMockAuth(page, {
            workspace: { workspaceRole: "VIEWER" },
            capabilitiesPreset: "viewer",
        });
        await setupMockSessions(page, {
            sessions: [{ id: "viewer-session", title: "Viewer Chat" }],
        });
        await page.goto(`/workspace/${WORKSPACE_ID}/chat/viewer-session`);
        await expect(page.getByTestId("chat-input"), "composer available for VIEWER").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
    });
});
