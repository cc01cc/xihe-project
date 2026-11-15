// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0658 M2：抄送（CC）交互矩阵（mock lane，无栈）。
 *
 * 覆盖清单（T1.2）：
 *  - 抄送栏默认收起 → `cc-expand` 展开出现候选；
 *  - 多选 chips：连续选两个 → 两枚 chip；`cc-chip-remove` 移除一枚；
 *  - 停用主体不出现（候选里永不出现 Agent Retired，打 "Retired" 只出空态）；
 *  - TO/CC 互斥：「发送」栏已选的参与者不再出现在抄送候选里；
 *  - @ 自动入抄送 + 手动移除抑制（同一 @ 还挂在草稿里时不自动加回）；
 *  - 无客户端上限：连续 3 枚 chip 不报错（上限在 CP 侧，real-lane R2 覆盖）。
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "test-session";

async function openComposer(page: Page): Promise<void> {
    await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}

/** 展开抄送栏（默认收起为「抄送 +」按钮）。 */
async function expandCc(page: Page): Promise<void> {
    const expand = page.getByTestId("cc-expand");
    if (await expand.isVisible().catch(() => false)) {
        await expand.click();
    }
    await expect(page.getByTestId("cc-bar"), "CC bar expanded").toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
}

/** 在抄送输入框里选一个候选（点菜单项，避开键盘焦点竞争）。 */
async function pickCc(page: Page, query: string): Promise<void> {
    const field = page.getByTestId("cc-input");
    await field.fill(query);
    const menu = page.getByTestId("cc-menu");
    await expect(menu, `CC typeahead opens for "${query}"`).toBeVisible({
        timeout: EXPECT_TIMEOUT_MS,
    });
    await menu.getByRole("option").first().click();
    await expect(menu, "CC menu closes after pick").toBeHidden({ timeout: EXPECT_TIMEOUT_MS });
}

test.describe("会话矩阵 M2 — 抄送交互", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Matrix M2" }] });
        await setupMockParticipants(page, SESSION_ID);
    });

    test("抄送栏默认收起，展开后出现输入与候选", async ({ page }) => {
        await openComposer(page);
        await expect(page.getByTestId("cc-bar"), "CC bar collapsed by default").toHaveCount(0);
        await expandCc(page);
        await expect(page.getByTestId("cc-input")).toBeVisible();
    });

    test("多选 chips：连续选两个 → 两枚 chip，移除一枚后剩一枚", async ({ page }) => {
        await openComposer(page);
        await expandCc(page);
        await pickCc(page, "Member");
        await expect(page.getByTestId("cc-chip"), "first CC chip").toHaveCount(1, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("cc-chip").first()).toContainText("Member Two");
        await pickCc(page, "Viewer");
        await expect(page.getByTestId("cc-chip"), "multi-select appends a second chip").toHaveCount(
            2,
            { timeout: ACTION_TIMEOUT_MS },
        );
        // 移除第一枚：多选不会因移除而清空其余。
        await page.getByTestId("cc-chip-remove").first().click();
        await expect(page.getByTestId("cc-chip"), "one chip removed").toHaveCount(1, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("cc-chip").first()).toContainText("Viewer Three");
    });

    test("停用主体不出现：打 Retired 只有空态，候选里没有它", async ({ page }) => {
        await openComposer(page);
        await expandCc(page);
        const field = page.getByTestId("cc-input");
        await field.fill("Retired");
        await expect(page.getByTestId("cc-empty"), "no candidate for a disabled agent").toBeVisible(
            { timeout: ACTION_TIMEOUT_MS },
        );
        await expect(page.getByTestId("cc-menu")).toHaveCount(0);
        // 打开全量候选（清空过滤）也绝不能出现停用行。
        await field.fill("");
        await field.fill("A");
        const menu = page.getByTestId("cc-menu");
        await expect(menu, "candidates render for a live query").toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await expect(menu.getByText("Agent Retired")).toHaveCount(0);
    });

    test("TO/CC 互斥：抄送候选排除「发送」栏当前选中者", async ({ page }) => {
        await openComposer(page);
        // 先把「发送」栏切到 Agent Alpha（默认是 owner）。
        const toField = page.getByTestId("speak-as-input");
        await toField.fill("Agent Alpha");
        await expect(page.getByTestId("speak-as-menu")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await toField.press("Enter");
        await expect(page.getByTestId("speak-as-chip").first()).toContainText("Agent Alpha");
        // 抄送候选里不应再出现 Agent Alpha。
        await expandCc(page);
        const ccField = page.getByTestId("cc-input");
        await ccField.fill("Alpha");
        await expect(page.getByTestId("cc-empty"), "TO selection excluded from CC").toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
    });

    test("@ 自动入抄送 + 手动移除抑制 + 清草稿后恢复", async ({ page }) => {
        await openComposer(page);
        const input = page.getByTestId("chat-input");
        // 从 @ 候选面点选「Member Two」，草稿里出现完整 @ 名 → 自动进抄送。
        await input.fill("@Member");
        const mentionMenu = page.getByTestId("chat-input-trigger-menu");
        await expect(mentionMenu).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await mentionMenu.getByText("Member Two").click();
        await expect(page.getByTestId("cc-chip"), "@ mention auto-added to CC").toHaveCount(1, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await expect(page.getByTestId("cc-chip").first()).toContainText("Member Two");
        // 手动移除：同一个 @ 还在草稿里 → 不再自动加回（ccSuppressed）。
        await page.getByTestId("cc-chip-remove").first().click();
        await expect(page.getByTestId("cc-chip"), "manually removed").toHaveCount(0, {
            timeout: ACTION_TIMEOUT_MS,
        });
        await input.press("End");
        await input.type(" 补充");
        await expect(
            page.getByTestId("cc-chip"),
            "suppressed @ must not auto-re-add while the draft keeps it",
        ).toHaveCount(0, { timeout: ACTION_TIMEOUT_MS });
        // 清空草稿（@ 消失）→ 再重新点名 → 自动加回。
        await input.fill("");
        await input.fill("@Member");
        await expect(mentionMenu).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await mentionMenu.getByText("Member Two").click();
        await expect(
            page.getByTestId("cc-chip"),
            "suppression resets once the @ left the draft",
        ).toHaveCount(1, { timeout: ACTION_TIMEOUT_MS });
    });

    test("无客户端上限：连续三枚 chip 不报错", async ({ page }) => {
        await openComposer(page);
        await expandCc(page);
        await pickCc(page, "Member");
        await pickCc(page, "Viewer");
        // 第三人：先占住「发送」栏（TO/CC 互斥会把它从抄送候选里排除），再用 **Agent Alpha** 凑第三枚。
        // task-239（2026-11-15）：原来这里选的是 "Owner"，而 `MATRIX_OWNER` 就是**当前登录用户自己**
        // （`helpers/session-matrix.ts:40-52`，`principalId: "user-1"`）。`f898696c5`（task-102，按用户裁定）
        // 已把调用者自己的真人行从 TO/CC 候选剔除（选中自己必撞 CP 400 `PARTICIPANT_SELF_TARGET`）
        // ⇒ 打 "Owner" 得空候选、而 `cc-menu` 是 `v-if="open && filtered.length > 0"` 的条件渲染
        // ⇒ 元素根本不渲染，报的是 `element(s) not found` 而不是"不可见"。
        // 本用例要钉的是「客户端不设 chip 上限」，与目标是谁无关 ⇒ 换成非自己、非 speak-as 的 Agent Alpha。
        const toField = page.getByTestId("speak-as-input");
        await toField.fill("Agent Beta");
        await expect(page.getByTestId("speak-as-menu")).toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await toField.press("Enter");
        await pickCc(page, "Agent Alpha");
        await expect(page.getByTestId("cc-chip"), "three chips allowed client-side").toHaveCount(
            3,
            {
                timeout: ACTION_TIMEOUT_MS,
            },
        );
    });
});
