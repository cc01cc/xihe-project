/**
 * PLAN-0658 M3：TO（发送）栏单选主体矩阵（mock lane，无栈）。
 *
 * 覆盖清单（T1.2）：
 *  - 「发送」栏候选 = **本人拥有的、未停用的参与者**（selfOwned 且 disabledAt 为空）：
 *    工作区 agent（selfOwned=true）在列；其他人类账户（非 selfOwned）不在列；
 *  - 已停用主体（Agent Retired）永远不出现；
 *  - 默认预选会话 PRIMARY（owner），单选取而代之。
 *
 * 断言口径：UI 候选列表内容 + chip 文本（wire 面由 real-lane R2 覆盖）。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";

const SESSION_ID = "test-session";

async function openComposer(page: Page): Promise<void> {
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
        timeout: 15_000,
    });
}

test.describe("会话矩阵 M3 — TO 单选主体", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Matrix M3" }] });
        await setupMockParticipants(page, SESSION_ID);
    });

    test("TO 候选只列 selfOwned 且未停用的参与者", async ({ page }) => {
        await openComposer(page);
        const field = page.getByTestId("speak-as-input");
        await expect(field, "TO field renders").toBeVisible({ timeout: 10_000 });
        await field.fill("A");
        const menu = page.getByTestId("speak-as-menu");
        await expect(menu, "TO typeahead opens").toBeVisible({ timeout: 10_000 });
        // selfOwned 的 agent 在列；其他人类账户与停用主体都不在列。
        await expect(menu.getByText("Agent Alpha"), "owned agent offered").toBeVisible();
        await expect(menu.getByText("Agent Beta"), "owned agent offered").toBeVisible();
        await expect(menu.getByText("Member Two"), "other human not selfOwned").toHaveCount(0);
        await expect(menu.getByText("Viewer Three"), "other human not selfOwned").toHaveCount(0);
        await expect(menu.getByText("Agent Retired"), "disabled agent never offered").toHaveCount(
            0,
        );
    });

    test("默认预选 PRIMARY，单选取而代之", async ({ page }) => {
        await openComposer(page);
        const chips = page.getByTestId("speak-as-chip");
        await expect(chips, "PRIMARY preselected").toHaveCount(1, { timeout: 10_000 });
        await expect(chips.first()).toContainText("Owner One");
        const field = page.getByTestId("speak-as-input");
        await field.fill("Agent Beta");
        await expect(page.getByTestId("speak-as-menu")).toBeVisible({ timeout: 10_000 });
        await field.press("Enter");
        await expect(chips, "single select keeps one chip").toHaveCount(1, { timeout: 10_000 });
        await expect(chips.first()).toContainText("Agent Beta");
    });

    test("清空输入后 Esc 关闭候选面（不误提交）", async ({ page }) => {
        await openComposer(page);
        const field = page.getByTestId("speak-as-input");
        await field.fill("Agent");
        await expect(page.getByTestId("speak-as-menu")).toBeVisible({ timeout: 10_000 });
        await field.press("Escape");
        await expect(page.getByTestId("speak-as-menu")).toBeHidden({ timeout: 10_000 });
        await expect(page.getByTestId("speak-as-chip"), "no accidental commit").toHaveCount(1);
    });
});
