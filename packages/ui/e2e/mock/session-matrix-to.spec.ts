// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * PLAN-0658 M3：TO（发送）栏收件人矩阵（mock lane，无栈）。
 *
 * 覆盖清单（T1.2，task-897 按现行契约重定）：
 *  - 「发送」栏候选 = **未停用 + 有 displayName + 不是调用者自己的真人行**
 *    （`InputArea.vue:321-325`）；工作区 agent 与其他人类账户都在列；
 *  - 调用者自己的真人行不在列（`InputArea.vue:315-319` / CP `PARTICIPANT_SELF_TARGET`）；
 *  - 已停用主体（Agent Retired）永远不出现。
 *
 * task-897（2026-11-23）：原「代发身份」字段（testid `speak-as-*`）已随 task-55 / D-1882③ 入口整块删除
 * （`InputArea.vue:1755-1782`），TO 字段改由 `RecipientField` 渲染（testid `to-targets`，
 * `InputArea.vue:1797-1810`）。原「默认预选会话 PRIMARY」用例随该入口一起退役，已删除（见 README）。
 *
 * 断言口径：UI 候选列表内容 + chip 文本（wire 面由 real-lane R2 覆盖）。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants } from "./helpers/session-matrix";
import { EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const SESSION_ID = "test-session";

async function openComposer(page: Page): Promise<void> {
    await page.goto(`/workspace/11111111-1111-4111-8111-111111111111/session/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}

test.describe("会话矩阵 M3 — TO 收件人候选", () => {
    test.beforeEach(async ({ page }) => {
        await setupMockAuth(page);
        await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: "Matrix M3" }] });
        await setupMockParticipants(page, SESSION_ID);
    });

    test("TO 候选 = 未停用 + 有名字 + 非自己的真人行", async ({ page }) => {
        await openComposer(page);
        const field = page.getByTestId("to-targets-input");
        await expect(field, "TO field renders").toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        await field.fill("e");
        const menu = page.getByTestId("to-targets-menu");
        await expect(menu, "TO typeahead opens").toBeVisible({ timeout: EXPECT_TIMEOUT_MS });
        // 现行判据（InputArea.vue:321-325）：未停用 + 有 displayName + 非自己的真人行。
        await expect(menu.getByText("Agent Alpha"), "enabled agent offered").toBeVisible();
        await expect(menu.getByText("Agent Beta"), "enabled agent offered").toBeVisible();
        await expect(menu.getByText("Member Two"), "other human offered").toBeVisible();
        await expect(menu.getByText("Viewer Three"), "other human offered").toBeVisible();
        await expect(menu.getByText("Owner One"), "caller's own human row excluded").toHaveCount(0);
        await expect(menu.getByText("Agent Retired"), "disabled agent never offered").toHaveCount(
            0,
        );
    });

    // task-897：原「默认预选 PRIMARY，单选取而代之」随「代发身份」入口整块退役
    // （`InputArea.vue:586-587` 说明 D-1882③ / task-55；`:280` `toTargetIds` 空初值）。
    // 按 D-1930 删除该用例，不改成「初始为空」的同名异义壳。

    test("清空输入后 Esc 关闭候选面（不误提交）", async ({ page }) => {
        await openComposer(page);
        const field = page.getByTestId("to-targets-input");
        await field.fill("Agent");
        await expect(page.getByTestId("to-targets-menu")).toBeVisible({
            timeout: EXPECT_TIMEOUT_MS,
        });
        await field.press("Escape");
        await expect(page.getByTestId("to-targets-menu")).toBeHidden({
            timeout: EXPECT_TIMEOUT_MS,
        });
        // RecipientField.vue:188-196：Esc 只关候选面、不 commit 输入 token；默认 TO 为空 ⇒ 仍 0 个 chip。
        await expect(page.getByTestId("to-targets-chip"), "no accidental commit").toHaveCount(0);
    });
});
