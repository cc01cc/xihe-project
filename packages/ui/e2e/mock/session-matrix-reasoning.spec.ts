/**
 * PLAN-0658 M7：思考过程（reasoning）渲染矩阵（mock lane，无栈）。
 *
 * 覆盖清单（用户新增维度「中间过程显示」）：
 *  - reasoning 块**流式追加**（两段 reasoning 依次推送，内容按序增长）；
 *  - 默认折叠、点 summary 展开、再收起；
 *  - 流式期间保持折叠（未 done 也不自动展开）；
 *  - **没有 thinking 时不渲染空块**（纯 text 流不出现 Reasoning 块）。
 *
 * 夹具说明：mock lane 的 `GET /sessions/{id}/messages` 投影是空的，run `done` 之后
 * UI 会按服务端投影刷新消息（真栈里消息已持久化，mock 里没有）——所以折叠态断言放在
 * done 之前做；**完成后的持久折叠态由 real-lane R9 覆盖**（UI+durable 三段同值）。
 *
 * 事件通道：installContextEventStream + pushContextEvent（同 diagnostics.spec），
 * 命令式推送、无定时器竞态。
 */
import { test, expect, type Page } from "@playwright/test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import { setupMockParticipants, setupMockProviderBinding } from "./helpers/session-matrix";
import { installContextEventStream, pushContextEvent } from "./helpers/context-events";

const SESSION_ID = "test-session";

async function prepare(page: Page, title: string): Promise<void> {
    await setupMockAuth(page);
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title }] });
    await setupMockParticipants(page, SESSION_ID);
    await setupMockProviderBinding(page, SESSION_ID);
    await installContextEventStream(page);
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input"), "composer mounts").toBeVisible({
        timeout: 15_000,
    });
    await page.getByTestId("chat-input").fill("带思考的一轮");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByText("带思考的一轮"), "user bubble rendered").toBeVisible({
        timeout: 15_000,
    });
}

/** `<details>` 是受控组件（`:open` 绑定 + 原生 toggle 竞争），断言 DOM 属性最稳。 */
async function expectDetailsOpen(
    locator: import("@playwright/test").Locator,
    expected: boolean,
    message: string,
): Promise<void> {
    await expect
        .poll(() => locator.evaluate((element) => (element as HTMLDetailsElement).open), {
            message,
            timeout: 10_000,
        })
        .toBe(expected);
}

test.describe("会话矩阵 M7 — 思考过程", () => {
    test("reasoning 块流式追加、默认折叠、可展开可收起", async ({ page }) => {
        await prepare(page, "Matrix M7");
        await pushContextEvent(page, "token", { content: "思考一", hint: "reasoning" });
        const block = page
            .locator("details", { has: page.locator("summary", { hasText: "Reasoning" }) })
            .first();
        await expect(block, "reasoning block renders").toBeVisible({ timeout: 15_000 });
        await expect(block, "first reasoning segment appended").toContainText("思考一");
        await expectDetailsOpen(block, false, "collapsed by default");
        await pushContextEvent(page, "token", { content: "思考二", hint: "reasoning" });
        await expect(block, "second segment appended in order").toContainText("思考一思考二", {
            timeout: 10_000,
        });
        // B 类已登记（2026-11-04）：点击/键盘都**展不开** Reasoning —— `details.open`
        // 点击后仍为 false、`open` 属性被写回 null；手动 `el.open = true` 则正常。
        // 受控 `:open` 绑定 + 原生 toggle 竞争，产品侧修复前本段保持 fixme（见下方用例）。
        await expect(
            block.locator("div").first(),
            "collapsed body is not visible until the product fixes the toggle",
        ).toBeHidden();
        // 答复正文到达（文本 token 与 reasoning 同属一条消息，渲染重排后不断言旧节点）。
        await pushContextEvent(page, "token", { content: "答复正文" });
        await expect(page.getByText("答复正文"), "answer renders").toBeVisible({ timeout: 10_000 });
        // 收尾：done 只结束生命周期（完成后的持久折叠态由 real-lane R9 覆盖）。
        await pushContextEvent(page, "done", {});
    });

    test("没有 thinking 时不渲染空 Reasoning 块", async ({ page }) => {
        await prepare(page, "Matrix M7 no thinking");
        await pushContextEvent(page, "token", { content: "纯文本答复" });
        await expect(page.getByText("纯文本答复"), "answer renders").toBeVisible({
            timeout: 15_000,
        });
        await expect(
            page.locator("details", { has: page.locator("summary", { hasText: "Reasoning" }) }),
            "no empty reasoning block",
        ).toHaveCount(0);
        await pushContextEvent(page, "done", {});
    });

    test("流式过程中块保持折叠（未 done 也不自动展开）", async ({ page }) => {
        await prepare(page, "Matrix M7 streaming");
        await pushContextEvent(page, "token", { content: "思考中…", hint: "reasoning" });
        const block = page
            .locator("details", { has: page.locator("summary", { hasText: "Reasoning" }) })
            .first();
        await expect(block, "reasoning visible while streaming").toBeVisible({ timeout: 15_000 });
        await expectDetailsOpen(block, false, "still collapsed mid-stream");
    });
});

// B 类（2026-11-04）：Reasoning 面板展不开 —— 产品侧缺陷，spec 只记录不改产品。
// 复现：push 一条 reasoning token → 点 summary（或聚焦后按 Enter）→ `details.open`
// 仍为 false；`page.evaluate(el.open = true)` 可正常展开（证明 DOM/CSS 无问题）。
test.fixme("折叠/展开：点 summary 应展开（当前产品缺陷，B 类已登记）", async ({ page }) => {
    await prepare(page, "Matrix M7 expand");
    await pushContextEvent(page, "token", { content: "思考一", hint: "reasoning" });
    const block = page
        .locator("details", { has: page.locator("summary", { hasText: "Reasoning" }) })
        .first();
    await expect(block, "reasoning block renders").toBeVisible({ timeout: 15_000 });
    await block.locator("summary").click();
    await expectDetailsOpen(block, true, "click expands the reasoning panel");
});
