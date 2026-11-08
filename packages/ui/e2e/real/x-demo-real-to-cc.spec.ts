// timeout-exempt: long E2E step(s) reviewed in task-252 (LONG_TIMEOUT_MS, default 30 s)
/**
 * X 图文「真实数据」版（task-15 用户追加；mock 版定构图后一次性真实运行）。
 *
 * token 经济（Lead D-77）：1 条验证消息（≤10 token）+ **最多 2 条正式消息**；提示词写死短答；
 * **构图问题只重截不重发**（本 spec 的 shot() 不发送任何消息）。预算超了直接 fail。
 *
 * 前置（脚本外已完成的 API 侧准备，见 README）：
 *  - demo 账号「陆星」+ USER-scope deepseek 连接（READY）+ workspace「产品交付线」；
 *  - agent 主体 Reviewer/Planner/Summarizer/Tester 已绑工作区；会话已绑定 provider/model/模板；
 *  - 状态由 `XIHE_DEMO_STATE_FILE` 指向的 JSON 提供（含 token/sessionId/workspaceId；**只读不打印**）。
 *
 * 真栈事实：UI 12630 / CP 12631，provider=deepseek model=deepseek-flash。
 * 限制：BL-239（TO/CC 本地态，发送后不刷新立即截）、BL-197（actor 只在实时会话，不滚旧消息）。
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTION_TIMEOUT_MS, EXPECT_TIMEOUT_MS, LONG_TIMEOUT_MS } from "../timeouts";

const REAL = process.env.XIHE_E2E_DEMO_REAL === "1";
const SHOT_DIR = process.env.XIHE_E2E_DEMO_DIR ?? "";
const STATE_FILE = process.env.XIHE_DEMO_STATE_FILE ?? "";
// Node 24 把 localhost 解析成 ::1，CP 只监听 IPv4 ⇒ 显式 127.0.0.1。
const CP = `http://127.0.0.1:${process.env.XIHE_CP_PORT ?? "12631"}`;

interface DemoState {
    token: string;
    email: string;
    password: string;
    workspaceId: string;
    sessionId: string;
    connectionId: string;
    baselineRuns?: number;
}

const PROMPTS = {
    /** 验证链路用（不算正式 run，报告里如实计数）。 */
    probe: "回复：ok",
    /** 正式 run 1：要求先读文件再短答（争取出现工具过程行 ⇒ actor 徽标）。 */
    run1: "先读 README，再用 20 字以内回答：本目录用于什么？",
    /** 正式 run 2：短答。 */
    run2: "用 20 字以内回答：评审安排在下周几？",
};

let state: DemoState;
// Demo-only counter: currently a constant (the promo spec reports 0 sends); kept read-only so the
// lint baseline (prefer-const) stays at zero.
const sentRuns = 0;

test.describe.configure({ mode: "serial", retries: 0 });
test.use({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });

async function waitTerminalCount(
    page: import("@playwright/test").Page,
    expected: number,
): Promise<void> {
    const deadline = Date.now() + 180_000;
    let last = "";
    while (Date.now() < deadline) {
        const payload = await page.evaluate(
            async ({ cp, sessionId, token }) => {
                // read-only: 只读轮询 chat run 列表（GET），判定终态与计数。
                const response = await fetch(
                    `${cp}/api/v1/chat/sessions/${sessionId}/runs?page=0&size=10`,
                    { headers: { Authorization: `Bearer ${token}` } },
                );
                if (!response.ok) return { error: `${response.status}` };
                return (await response.json()) as { runs?: { status?: string }[] };
            },
            { cp: CP, sessionId: state.sessionId, token: state.token },
        );
        const runs = (payload as { runs?: { status?: string }[] }).runs ?? [];
        const terminal = runs.filter((run) =>
            ["succeeded", "failed", "partial", "ambiguous", "cancelled"].includes(run.status ?? ""),
        ).length;
        last = JSON.stringify(runs.map((run) => run.status));
        if (terminal >= expected) return;
        await page.waitForTimeout(700);
    }
    throw new Error(`run 未在超时内终态: ${last}`);
}

async function settle(page: import("@playwright/test").Page): Promise<void> {
    // idle 判据 = composer 回到「发送」按钮（流式态是 `chat-stop-button`）。
    await expect(page.getByTestId("chat-send-button")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    // 真实链路首次发送可能触发 bind-defaults toast；等它自动消失（≤5s）再截。
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: LONG_TIMEOUT_MS });
    await page.waitForTimeout(500);
}

async function shot(page: import("@playwright/test").Page, name: string): Promise<void> {
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
    );
    console.log(`[real-demo] shot=${name} hOverflow=${overflow}`);
    await page.screenshot({ path: join(SHOT_DIR, name), scale: "css" });
}

async function pickCc(page: import("@playwright/test").Page, name: string): Promise<void> {
    if ((await page.getByTestId("cc-bar").count()) === 0)
        await page.getByTestId("cc-expand").click();
    await page.getByTestId("cc-input").fill(name);
    const menu = page.getByTestId("cc-menu");
    await expect(menu).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await menu.getByRole("option").first().click();
    await expect(menu).toBeHidden({ timeout: LONG_TIMEOUT_MS });
}

async function openMembersDock(page: import("@playwright/test").Page): Promise<void> {
    const toggle = page.getByTestId("workspace-toolbar-members");
    if ((await page.getByTestId("dock-tab-members").count()) === 0) await toggle.click();
    await expect(page.getByTestId("dock-tab-members")).toBeVisible({ timeout: LONG_TIMEOUT_MS });
    await expect(page.getByText("Reviewer", { exact: true }).first()).toBeVisible({
        timeout: LONG_TIMEOUT_MS,
    });
}

test.describe("X 演示截图（真实数据：deepseek-flash）", () => {
    test.skip(!REAL, "只有 XIHE_E2E_DEMO_REAL=1 时执行");

    test.beforeAll(async ({ request }) => {
        mkdirSync(SHOT_DIR, { recursive: true });
        state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as DemoState;
        expect(state.sessionId, "state.sessionId").toBeTruthy();
        // 演示 token 会过期（TTL 很短）：每次跑前用 demo 账号 API 登录换新 token，不落盘打印。
        const login = await request.post(`${CP}/api/v1/auth/login`, {
            data: { identifier: state.email, password: state.password },
        });
        expect(login.status(), `demo login: ${login.status()}`).toBe(200);
        state.token = ((await login.json()) as { accessToken: string }).accessToken;
        // 断点续跑：先数已有 run（本轮只补 1 条正式消息，token 经济）。
        const runs = await request.get(
            `${CP}/api/v1/chat/sessions/${state.sessionId}/runs?page=0&size=20`,
            {
                headers: { Authorization: `Bearer ${state.token}` },
            },
        );
        expect(runs.status(), `runs list: ${runs.status()}`).toBe(200);
        const rows = ((await runs.json()) as { runs?: unknown[] }).runs ?? [];
        state.baselineRuns = rows.length;
        console.log(`[real-demo] baselineRuns=${state.baselineRuns}`);
    });

    test("①-④ 真实 provider 一次跑对", async ({ page }) => {
        // seed 与 real-lane `seedPage()` 同构；token 由 beforeAll 现场换新（不落盘）。
        await page.addInitScript((token) => localStorage.setItem("xihe-token", token), state.token);
        await page.addInitScript(
            (workspaceId) => localStorage.setItem("xihe-user", JSON.stringify({ workspaceId })),
            state.workspaceId,
        );
        await page.addInitScript(
            (workspace) => {
                localStorage.setItem("xihe-workspace", JSON.stringify(workspace));
                localStorage.setItem("xihe-theme", "light");
            },
            { id: state.workspaceId, name: "产品交付线" },
        );
        const consoleErrors: string[] = [];
        page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(message.text());
        });
        page.on("pageerror", (error) =>
            consoleErrors.push(`${error.message}\n${(error.stack ?? "").slice(0, 1200)}`),
        );
        page.on("requestfailed", (request) =>
            consoleErrors.push(
                `requestfailed ${request.url()} ${request.failure()?.errorText ?? ""}`,
            ),
        );

        await page.goto(`/workspace/${state.workspaceId}/chat/${state.sessionId}`);
        await page.waitForTimeout(3000);
        await page.screenshot({ path: join(SHOT_DIR, "_debug-boot.png"), scale: "css" });
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
        const htmlText = await page.evaluate(() => document.body.innerHTML.slice(0, 400));
        console.log(
            `[real-demo] boot url=${page.url()} text=${JSON.stringify(bodyText)} html=${JSON.stringify(htmlText)} consoleErrors=${consoleErrors.length} all=${JSON.stringify(consoleErrors.slice(0, 3))}`,
        );
        await expect(page.locator("textarea").first(), "composer").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        // 成员 dock 常开（多主体在席：2 人类 + 4 agent），CC 3 个；TO 保持默认 PRIMARY（单选）。
        await openMembersDock(page);
        await pickCc(page, "Planner");
        await pickCc(page, "Summarizer");
        await pickCc(page, "林小满");
        await page.locator("textarea").first().fill(PROMPTS.run1);
        await shot(page, "01-to-cc-chips.png");

        // 只剩 1 条正式消息预算（总 run 4）：发送后立刻验证 BL-270 —— 不应出现 bind-defaults toast。
        await page.getByTestId("chat-send-button").click();
        await page.waitForTimeout(1800);
        const toast = await page.evaluate(() => ({
            count: document.querySelectorAll("[data-sonner-toast]").length,
            text: Array.from(document.querySelectorAll("[data-sonner-toast]"))
                .map((node) => (node.textContent ?? "").trim())
                .join(" | "),
        }));
        const toastAt = new Date().toISOString();
        await page.screenshot({
            path: join(SHOT_DIR, `_debug-toast-${toastAt.replace(/[:.]/g, "-")}.png`),
            scale: "css",
        });
        console.log(
            `[real-demo] toast_check at=${toastAt} count=${toast.count} text=${JSON.stringify(toast.text)}`,
        );
        if (toast.count > 0) {
            throw new Error(`BL-270 未覆盖该路径：仍有 toast「${toast.text}」（at ${toastAt}）`);
        }

        await waitTerminalCount(page, (state.baselineRuns ?? 0) + 1);
        await settle(page);
        await page.getByTestId("message-delivery").first().scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await shot(page, "02-delivery-header.png");

        // ③ 成员面板（dock 常开：真实运行 2 人类 + 4 agent）
        await openMembersDock(page);
        await expect(page.getByText("林小满", { exact: true }).first()).toBeVisible({
            timeout: ACTION_TIMEOUT_MS,
        });
        await page.waitForTimeout(400);
        await shot(page, "03-members-panel.png");

        // ④ run 分组 + actor：构图需要宽度，关掉 dock 后贴底截。
        const closePanel = page.getByRole("button", { name: "关闭此面板" });
        if ((await closePanel.count()) > 0) await closePanel.first().click();
        await page.mouse.move(720, 420);
        await page.mouse.wheel(0, 1600);
        await page.waitForTimeout(500);
        await shot(page, "04-run-grouping-actor.png");

        console.log(`[real-demo] total sends=${sentRuns} baselineRuns=${state.baselineRuns ?? 0}`);
    });

    /**
     * real 卡主视觉（零 run）：打开历史会话 → 成员面板 + 发送/抄送 chips 同框 → 2x 采集。
     * 不发任何消息，跑前跑后 runs 数必须一致（token 账可核）。
     */
    test("card-visual 零 run（历史会话 + 成员面板 + chips）", async ({ page }) => {
        await page.addInitScript((token) => localStorage.setItem("xihe-token", token), state.token);
        await page.addInitScript(
            (workspaceId) => localStorage.setItem("xihe-user", JSON.stringify({ workspaceId })),
            state.workspaceId,
        );
        await page.addInitScript(
            (workspace) => {
                localStorage.setItem("xihe-workspace", JSON.stringify(workspace));
                localStorage.setItem("xihe-theme", "light");
            },
            { id: state.workspaceId, name: "产品交付线" },
        );
        // 卡构图：右栏 pinned + 480 宽（1440 视口默认 floating 会盖住聊天区），文件树收起。
        await page.addInitScript((workspaceId) => {
            localStorage.setItem(
                `xihe-layout-ws:${workspaceId}`,
                JSON.stringify({
                    treeCollapsed: true,
                    treeWidth: 240,
                    dockCollapsed: false,
                    dockWidth: 480,
                    dockTabs: ["members"],
                    activeDockTab: "members",
                    dockMode: "pinned",
                    dockModeManual: true,
                    openTabs: [],
                }),
            );
        }, state.workspaceId);

        const countRuns = async (): Promise<number> =>
            page.evaluate(async (sessionId) => {
                // read-only: 只读统计 chat run 数量（GET），不写任何状态。
                const response = await fetch(
                    `/api/v1/chat/sessions/${sessionId}/runs?page=0&size=50`,
                    {
                        headers: {
                            Authorization: `Bearer ${localStorage.getItem("xihe-token") ?? ""}`,
                        },
                    },
                );
                const body = (await response.json()) as { runs?: unknown[] };
                return (body.runs ?? []).length;
            }, state.sessionId);

        await page.goto(`/workspace/${state.workspaceId}/chat/${state.sessionId}`);
        await expect(page.locator("textarea").first(), "composer").toBeVisible({
            timeout: LONG_TIMEOUT_MS,
        });
        const runsBefore = await countRuns();
        await openMembersDock(page);
        await pickCc(page, "Planner");
        await pickCc(page, "Summarizer");
        await pickCc(page, "林小满");
        await page.locator("textarea").first().fill("@Planner 排期也一起看一眼。");
        await expect(page.getByTestId("cc-bar")).toContainText("林小满", {
            timeout: EXPECT_TIMEOUT_MS,
        });
        // 取「更早、干净的那段真实对话」入镜（probe 往返 + run 头），滚到会话顶部；composer 固定底部。
        await page.mouse.move(700, 420);
        await page.mouse.wheel(0, -6000);
        await page.waitForTimeout(400);
        // 与 mock 卡一致：隐藏会话列表侧栏与 nav rail（纯展示隐藏，不改产品）。
        await page.addStyleTag({
            content: '[data-testid="sidebar"],[data-testid="nav-rail"]{display:none!important}',
        });
        await page.waitForTimeout(500);
        await page.screenshot({
            path: join(SHOT_DIR, "06-card-visual.png"),
            scale: "device",
        });

        // 同一趟零 run 补拍长页所需的两帧：成员面板（dock 开）与 run 分组（dock 关、贴底）。
        await shot(page, "03-members-panel.png");
        const closePanel = page.getByRole("button", { name: "关闭此面板" });
        if ((await closePanel.count()) > 0) await closePanel.first().click();
        await page.mouse.move(720, 420);
        await page.mouse.wheel(0, 1600);
        await page.waitForTimeout(500);
        await shot(page, "04-run-grouping-actor.png");

        const runsAfter = await countRuns();
        expect(runsAfter, "零 run：采集前后 runs 数一致").toBe(runsBefore);
        console.log(`[real-demo] card-visual runsBefore=${runsBefore} runsAfter=${runsAfter}`);
    });
});
