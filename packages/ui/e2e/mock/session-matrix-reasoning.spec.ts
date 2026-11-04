/**
 * PLAN-0658 M7：思考过程（reasoning）渲染矩阵（mock lane，无栈）。
 *
 * 覆盖清单（用户新增维度「中间过程显示」）：
 *  - reasoning 过程行**流式追加**（两段 reasoning 依次推送，内容按序增长）；
 *  - **默认折叠**（`process-row-toggle` 的 `aria-expanded=false`，展开体不渲染）；
 *  - 点折叠按钮**能展开/收起**（2026-11-04 产品换成 `ProcessRow` 单行 chip 后此缺陷已消失，
 *    原 `<details>` 时代的 fixme 已转为真实用例）；
 *  - **没有 thinking 时不渲染空块**（纯 text 流不出现 `process-reasoning` 行）。
 *
 * 2026-11-04 夹具更新：产品「过程渲染统一为单行可折叠 chip」落地（`ProcessRow.vue` /
 * `ReasoningPart.vue`，commit `0bfdb31c`，merge `d7ef9996`）后，旧的
 * `<details>/<summary>` 定位器全部失效（mock M7 因此红了 2 条）。本文件改认
 * `process-reasoning` / `process-row-toggle` / `aria-expanded` 这套**现行契约**；
 * 真栈的「完成/刷新后持久折叠态」仍由 real-lane R9 覆盖（UI + durable 三段同值）。
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

/** 现行的 reasoning 过程行（`ProcessRow` 单行 chip，kind=reasoning）。 */
function reasoningRow(page: Page) {
    return page.getByTestId("process-reasoning").first();
}

test.describe("会话矩阵 M7 — 思考过程", () => {
    test("reasoning 过程行流式追加、默认折叠、可展开可收起", async ({ page }) => {
        await prepare(page, "Matrix M7");
        await pushContextEvent(page, "token", { content: "思考一", hint: "reasoning" });
        const row = reasoningRow(page);
        await expect(row, "reasoning 过程行渲染").toBeVisible({ timeout: 15_000 });
        // 折叠行只显示首行摘要（正文只在展开体里）。
        await expect(row.getByTestId("process-row-summary")).toContainText("思考一");
        const toggle = row.getByTestId("process-row-toggle");
        await expect(toggle, "默认折叠").toHaveAttribute("aria-expanded", "false");

        // 第二段 reasoning 追加（同一 part 合并 ⇒ 展开体里应见到两段按序拼接）。
        await pushContextEvent(page, "token", { content: "思考二", hint: "reasoning" });
        await toggle.click();
        await expect(toggle, "展开").toHaveAttribute("aria-expanded", "true");
        await expect(row, "两段 reasoning 按序追加").toContainText("思考一思考二", {
            timeout: 10_000,
        });
        // 再收起：展开体消失，摘要仍在。
        await toggle.click();
        await expect(toggle, "收起").toHaveAttribute("aria-expanded", "false");
        await expect(row.getByTestId("process-row-summary")).toContainText("思考一");

        // 答复正文到达（文本 token 与 reasoning 同属一条消息，渲染重排后不断言旧节点）。
        await pushContextEvent(page, "token", { content: "答复正文" });
        await expect(page.getByText("答复正文"), "answer renders").toBeVisible({ timeout: 10_000 });
        // 收尾：done 只结束生命周期（完成后的持久折叠态由 real-lane R9 覆盖）。
        await pushContextEvent(page, "done", {});
    });

    test("没有 thinking 时不渲染空 Reasoning 过程行", async ({ page }) => {
        await prepare(page, "Matrix M7 no thinking");
        await pushContextEvent(page, "token", { content: "纯文本答复" });
        await expect(page.getByText("纯文本答复"), "answer renders").toBeVisible({
            timeout: 15_000,
        });
        await expect(page.getByTestId("process-reasoning"), "no empty reasoning row").toHaveCount(
            0,
        );
        await pushContextEvent(page, "done", {});
    });

    test("流式过程中过程行保持折叠（未 done 也不自动展开）", async ({ page }) => {
        await prepare(page, "Matrix M7 streaming");
        await pushContextEvent(page, "token", { content: "思考中…", hint: "reasoning" });
        const row = reasoningRow(page);
        await expect(row, "reasoning 过程行在流式期可见").toBeVisible({ timeout: 15_000 });
        await expect(row.getByTestId("process-row-toggle"), "流式期仍折叠").toHaveAttribute(
            "aria-expanded",
            "false",
        );
    });
});
