/**
 * PLAN-0658 M8：工具与命令过程渲染矩阵（mock lane，无栈）。
 *
 * 覆盖清单（用户新增维度「中间过程显示」）：
 *  - tool call 卡三态：执行中（running）/ 完成（completed）/ 失败（failed）；
 *  - `exec_command` 输出渲染（raw-arguments 的命令、raw-result 的 stdout、超长截断提示）；
 *  - **refusal 卡**（BL-220 / PLAN-0649：`tool-refusal` + `tool-refusal-code`；
 *    判据是 `refusalCode` 而不是 status）；
 *  - 多工具连续调用的**顺序**。
 *
 * 失败态走产品自身规则（useSSE.toolResultStatus）：result 以 `Tool error:` 开头 ⇒ failed。
 * 事件通道：installContextEventStream + pushContextEvent（同 diagnostics.spec）。
 */
import { type Page } from "@playwright/test";
import { expect, test } from "./helpers/mock-test";
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
    await page.getByTestId("chat-input").fill("跑个命令");
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByText("跑个命令"), "user bubble rendered").toBeVisible({
        timeout: 15_000,
    });
}

test.describe("会话矩阵 M8 — 工具与命令过程", () => {
    test("exec_command 卡：执行中→完成，参数与 stdout 可展开查看", async ({ page }) => {
        await prepare(page, "Matrix M8 exec");
        await pushContextEvent(page, "tool_call", {
            tool: "execute_command",
            toolCallId: "tc-1",
            arguments: { command: "dir" },
        });
        const card = page.getByTestId("tool-card-toggle").first();
        await expect(card, "tool card renders").toBeVisible({ timeout: 15_000 });
        await expect(card, "tool name on the header").toContainText("execute_command");
        await expect(card, "running status label").toContainText("执行中");
        await pushContextEvent(page, "tool_result", {
            toolCallId: "tc-1",
            result: "file1.txt\nfile2.txt",
        });
        await expect(card, "completed status label").toContainText("已完成", { timeout: 10_000 });
        await card.click();
        await expect(
            page.getByTestId("raw-arguments").first(),
            "command args rendered",
        ).toContainText("dir", { timeout: 10_000 });
        await expect(page.getByTestId("raw-result").first(), "stdout rendered").toContainText(
            "file1.txt",
        );
    });

    test("失败工具：result 以 Tool error 开头 ⇒ 状态为「执行失败」", async ({ page }) => {
        await prepare(page, "Matrix M8 failed");
        await pushContextEvent(page, "tool_call", {
            tool: "exec_command",
            toolCallId: "tc-fail",
            arguments: { command: "exit 1" },
        });
        await pushContextEvent(page, "tool_result", {
            toolCallId: "tc-fail",
            result: "Tool error: command exited with code 1",
        });
        const card = page.getByTestId("tool-card-toggle").first();
        await expect(card, "failed status label").toContainText("执行失败", { timeout: 15_000 });
        await card.click();
        await expect(page.getByTestId("raw-result").first()).toContainText("Tool error", {
            timeout: 10_000,
        });
    });

    test("refusal 卡：refusalCode 呈现错误码（不是执行失败）", async ({ page }) => {
        await prepare(page, "Matrix M8 refusal");
        await pushContextEvent(page, "tool_call", {
            tool: "write_file",
            toolCallId: "tc-refused",
            arguments: { path: "a.md" },
        });
        await pushContextEvent(page, "tool_result", {
            toolCallId: "tc-refused",
            result: "",
            refusalCode: "TOOL_GRANT_DENIED",
        });
        const card = page.getByTestId("tool-card-toggle").first();
        await expect(card, "refusal card renders").toBeVisible({ timeout: 15_000 });
        await card.click();
        await expect(page.getByTestId("tool-refusal"), "refusal block visible").toBeVisible({
            timeout: 10_000,
        });
        await expect(page.getByTestId("tool-refusal-code"), "refusal code rendered").toHaveText(
            "TOOL_GRANT_DENIED",
        );
    });

    test("超长输出：raw-result 保留开头并显示截断提示", async ({ page }) => {
        await prepare(page, "Matrix M8 truncation");
        const longOutput = `BEGIN-OF-LONG-OUTPUT\n${"x".repeat(2600)}`;
        await pushContextEvent(page, "tool_call", {
            tool: "exec_command",
            toolCallId: "tc-long",
            arguments: { command: "cat big.log" },
        });
        await pushContextEvent(page, "tool_result", { toolCallId: "tc-long", result: longOutput });
        const card = page.getByTestId("tool-card-toggle").first();
        await expect(card, "card renders").toBeVisible({ timeout: 15_000 });
        await card.click();
        await expect(page.getByTestId("raw-result").first()).toContainText("BEGIN-OF-LONG-OUTPUT", {
            timeout: 10_000,
        });
        await expect(page.getByText(/Output truncated \(\d+ chars total\)/)).toBeVisible({
            timeout: 10_000,
        });
    });

    test("多工具连续调用：两张卡按调用顺序排列", async ({ page }) => {
        await prepare(page, "Matrix M8 sequence");
        await pushContextEvent(page, "tool_call", {
            tool: "read_file",
            toolCallId: "tc-a",
            arguments: { path: "README.md" },
        });
        await pushContextEvent(page, "tool_result", { toolCallId: "tc-a", result: "# readme" });
        await pushContextEvent(page, "tool_call", {
            tool: "exec_command",
            toolCallId: "tc-b",
            arguments: { command: "dir" },
        });
        await pushContextEvent(page, "tool_result", { toolCallId: "tc-b", result: "a.txt" });
        const cards = page.getByTestId("tool-card-toggle");
        await expect(cards, "two tool cards").toHaveCount(2, { timeout: 15_000 });
        await expect(cards.nth(0), "first call first").toContainText("read_file");
        await expect(cards.nth(1), "second call second").toContainText("exec_command");
    });
});
