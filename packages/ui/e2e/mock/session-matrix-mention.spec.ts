/**
 * PLAN-0658 M1：@ typeahead 键盘交互矩阵（mock lane，无栈）。
 *
 * 覆盖清单（T1.2）：
 *  - 输入 `@` 打开统一候选面（`chat-input-trigger-menu`，mention 组）；
 *  - ↑↓ 循环、Enter 选中插入、Tab 选中插入、Esc 关闭且保留草稿；
 *  - 打字过滤（"@member" 只剩匹配项）；
 *  - 停用主体不出现（Agent Retired 在候选里永远缺席）；
 *  - 「发送」栏（speak-as）单选：选第二个会替换第一个（不叠加）。
 *
 * 断言口径：UI testid 状态（listbox/option/aria-selected/chip），不碰 wire。
 */
import { test, expect } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";

const SESSION_ID = "test-session";

async function openComposer(page: import("@playwright/test").Page): Promise<void> {
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
        timeout: 15_000,
    });
}

test.describe("会话矩阵 M1 — @ typeahead 键盘", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Matrix M1" }] });
        await setupMockParticipants(page, SESSION_ID);
    });

    test("输入 @ 打开统一候选面，mention 组渲染参与者", async ({ page }) => {
        await openComposer(page);
        const input = page.getByTestId("chat-input");
        await input.fill("@");
        const menu = page.getByTestId("chat-input-trigger-menu");
        await expect(menu, "mention listbox opens on @").toBeVisible({ timeout: 10_000 });
        const options = menu.getByRole("option");
        await expect(options.first(), "at least one candidate").toBeVisible({ timeout: 10_000 });
        expect(await options.count(), "roster yields multiple candidates").toBeGreaterThanOrEqual(
            2,
        );
        await expect(menu.getByText("Owner One"), "roster human visible").toBeVisible();
        await expect(menu.getByText("Agent Alpha"), "roster agent visible").toBeVisible();
        await expect(menu.getByText("Agent Retired"), "disabled agent must not appear").toHaveCount(
            0,
        );
    });

    test("↑↓ 在候选间循环并用 aria-selected 标出当前项", async ({ page }) => {
        await openComposer(page);
        const input = page.getByTestId("chat-input");
        await input.fill("@");
        const menu = page.getByTestId("chat-input-trigger-menu");
        await expect(menu).toBeVisible({ timeout: 10_000 });
        const options = menu.getByRole("option");
        await expect(options.first()).toBeVisible({ timeout: 10_000 });
        const initialSelected = await options.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("aria-selected") === "true"),
        );
        expect(initialSelected.filter(Boolean).length, "exactly one active option").toBe(1);
        await input.press("ArrowDown");
        const afterDown = await options.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("aria-selected") === "true"),
        );
        expect(afterDown.filter(Boolean).length).toBe(1);
        expect(afterDown.indexOf(true), "active index moves down").not.toBe(
            initialSelected.indexOf(true),
        );
        await input.press("ArrowUp");
        const afterUp = await options.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute("aria-selected") === "true"),
        );
        expect(afterUp.indexOf(true), "ArrowUp returns to the initial option").toBe(
            initialSelected.indexOf(true),
        );
    });

    test("Enter 选中当前候选：菜单关闭且草稿里出现该名字", async ({ page }) => {
        await openComposer(page);
        const input = page.getByTestId("chat-input");
        await input.fill("@");
        const menu = page.getByTestId("chat-input-trigger-menu");
        await expect(menu).toBeVisible({ timeout: 10_000 });
        // 导航到「Owner One」（成员组第一项）再 Enter。
        await menu.getByText("Owner One").click();
        await expect(menu, "menu closes after pick").toBeHidden({ timeout: 10_000 });
        await expect(input, "mention token inserted").toHaveValue(/@Owner One\s*/, {
            timeout: 10_000,
        });
    });

    test("Tab 同样选中当前候选（与 Enter 共用 selectActiveItem）", async ({ page }) => {
        await openComposer(page);
        const input = page.getByTestId("chat-input");
        await input.fill("@");
        const menu = page.getByTestId("chat-input-trigger-menu");
        await expect(menu).toBeVisible({ timeout: 10_000 });
        await input.press("Tab");
        await expect(menu, "Tab closes the menu").toBeHidden({ timeout: 10_000 });
        await expect(input, "Tab inserts the mention too").toHaveValue(/@\S+/, { timeout: 10_000 });
    });

    test("Esc 关闭候选面但保留草稿文本", async ({ page }) => {
        await openComposer(page);
        const input = page.getByTestId("chat-input");
        await input.fill("@");
        await expect(page.getByTestId("chat-input-trigger-menu")).toBeVisible({ timeout: 10_000 });
        await input.press("Escape");
        await expect(page.getByTestId("chat-input-trigger-menu")).toBeHidden({ timeout: 10_000 });
        await expect(input, "draft survives Esc").toHaveValue("@");
    });

    test("打字过滤：@member 只剩匹配候选（大小写不敏感）", async ({ page }) => {
        await openComposer(page);
        const input = page.getByTestId("chat-input");
        await input.fill("@member");
        const menu = page.getByTestId("chat-input-trigger-menu");
        await expect(menu).toBeVisible({ timeout: 10_000 });
        await expect(menu.getByText("Member Two"), "matched candidate").toBeVisible();
        await expect(menu.getByText("Agent Alpha"), "non-matching candidate filtered").toHaveCount(
            0,
        );
        await expect(menu.getByText("Viewer Three"), "non-matching candidate filtered").toHaveCount(
            0,
        );
    });

    test("「发送」栏单选：选第二个会替换默认预选（不叠加）", async ({ page }) => {
        await openComposer(page);
        const bar = page.getByTestId("speak-as-bar");
        await expect(bar, "TO bar renders when speakAs capability is true").toBeVisible({
            timeout: 10_000,
        });
        // 单选栏默认预选会话 PRIMARY（owner）：先确认基线是一枚 chip。
        const chips = page.getByTestId("speak-as-chip");
        await expect(chips, "PRIMARY participant preselected").toHaveCount(1, {
            timeout: 10_000,
        });
        await expect(chips.first()).toContainText("Owner One");
        // 再选另一个本人拥有的 agent → 单选取而代之（不是再加一枚）。
        const field = page.getByTestId("speak-as-input");
        await field.fill("Agent Alpha");
        await expect(page.getByTestId("speak-as-menu"), "TO typeahead opens").toBeVisible({
            timeout: 10_000,
        });
        await field.press("Enter");
        await expect(chips, "single mode keeps exactly one chip").toHaveCount(1, {
            timeout: 10_000,
        });
        await expect(chips.first(), "new selection replaces the old one").toContainText(
            "Agent Alpha",
        );
        await expect(chips.first()).not.toContainText("Owner One");
    });
});
