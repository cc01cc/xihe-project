// timeout-exempt: 量测工具：每个场景固定 30 s 观测窗（量测口径本身），故单测需 60 s
/**
 * 工作区 SSE 连接数**量测工具**（task-101）。
 *
 * ## 这不是用例
 * 它**不承担任何行为判据**：唯一的断言是「量到至少一次连接」= 量具自检（量具坏了要立刻知道），
 * 不是「产品对不对」。任何行为判据请另写 spec（本轮的行为判据在
 * `e2e/mock/sse-reconnect-backoff.spec.ts`：第 1→5 次连接跨度 > 2.5 s）。
 *
 * ## 它为什么存在
 * 2026-11-11 的分诊证据（`ee7a01909` 批 1 / 9 / 9、合流树批 1 / 10 / 9、隔离腿旧产品 105）
 * 原本全靠一支**未入库、跑完即删**的临时探针跑出来 ⇒ 别人无法复算，只能信日志。
 * 把探针做成入库的工具后，那些数字可以**一条命令重新量出来**。
 * **诚实边界**：入库是**事后补上的能力**，不是当时的证明条件；本轮三批数是在本文件存在之前跑的。
 *
 * ## 怎么启用（常规批默认 skip，原因见下）
 * 仓库的 `testMatch` 只扫 `e2e/mock/*.spec.ts`（顶层）⇒ 本文件必须在顶层，
 * 否则它既不会出现在常规报告里、也无法用显式路径跑（Playwright 的显式路径仍在 testMatch 之内过滤）。
 *
 * Windows PowerShell，一条命令拿到三个数 —— **浏览器显式钉成 chrome-beta**（与 `mise run test:mock` 一致）：
 * 裸跑不设 `XIHE_E2E_BROWSER_CHANNEL` 会用 Playwright bundled Chromium，与历史基线**不是同一个引擎**。
 * ```
 * $env:XH_MEASURE_SSE='1'; $env:XIHE_UI_PORT='12795'; $env:XIHE_E2E_BROWSER_CHANNEL='chrome-beta';
 * pnpm exec playwright test --config e2e/playwright.config.ts --workers=1 --retries=0 --reporter=line e2e/mock/measure-sse-connects.spec.ts;
 * Remove-Item Env:XH_MEASURE_SSE, Env:XIHE_E2E_BROWSER_CHANNEL
 * ```
 * 终端里会出现三行 `MEASURE_WINDOW={...}`，字段与 2026-11-11 那几批**逐字同格式**，可直接对账：
 * - `hold` ⇒ 预期 `connects: 1`（**对照**：流永不关闭 ⇒ 无重连；不是 1 就是量具坏了）
 * - `close-soon` ⇒ 预期落在 `[7, 11]`（带宽由 `retryDelay` 的 `rand(0..base/4)` 派生）
 * - `event-then-close` ⇒ 预期与 `close-soon` 相差 ≤1（R3 否证的实质：有无事件对结果无影响）
 * 预期值写在这里是**给人读的对账参考**，不是断言；脚本不会因此变红。
 *
 * ## 数的身份必须自证（browserChannel / browserVersion）
 * 每条量测都会先打印一行 `MEASURE_ENV={"browserChannel":…,"browserVersion":…,"windowMs":…}`，
 * 再打印 `MEASURE_WINDOW=…`。原因：**2026-11-11 那几批历史数（1 / 9 / 9、1 / 10 / 9、隔离腿 105）
 * 全是在 bundled Chromium 上跑的**（当时未设 `XIHE_E2E_BROWSER_CHANNEL`，见 `e2e/playwright.config.ts:8,42`）。
 * 换引擎（例如钉 `chrome-beta`，与 `mise run test:mock` 一致）后，这些数**只能算「大致能复现」而不是「能复现」** ——
 * 谁拿 Chrome Beta 的数去对 Chromium 的基线，就会得出错误的回归结论。
 * 另注：「Chrome Beta 进程数 = 0」这条判据**只覆盖有头 Beta 一种形态**，它证明不了 bundled Chromium 跑量测时 CPU 上没有别人。
 *
 * ## 场景为什么写死在代码里
 * 靠环境变量（`XH_FIXTURE_SSE_SCENARIO`）会让「忘设 env」跑成 `hold` 却照样"有数"，
 * 那种数据不携带信息。这里每个 test 显式传 `workspaceEventsScenario`。
 */
import { expect, test } from "./helpers/mock-test";
import { setupMockAuth, setupMockSessions } from "./helpers/auth";
import type { WorkspaceStreamScenario } from "./helpers/context-events";

/** 量测口径：固定 30 s 观测窗（与 2026-11-11 历史批次一致，不可随意改）。 */
const WINDOW_MS = 30_000;
const SESSION_ID = "measure-sse-connects";

test.skip(
    process.env.XH_MEASURE_SSE !== "1",
    "量测工具（非用例）：常规批跳过。启用方式见文件头——$env:XH_MEASURE_SSE='1' 后跑 e2e/mock/measure-sse-connects.spec.ts",
);

/**
 * 量一个场景：挂载 chat 页 → 数 30 s 内的工作区 SSE 连接 → 打印一行 `MEASURE_WINDOW=…`。
 *
 * 计数口径与历史批次一致：控制台 `chat_sse_connect_started` 且 `sessionId: workspace:*`。
 */
async function measureWindow(
    page: import("@playwright/test").Page,
    scenario: WorkspaceStreamScenario,
    label: string,
): Promise<{ connects: number; cleanCloses: number }> {
    let connects = 0;
    let cleanCloses = 0;
    page.on("console", (message) => {
        const text = message.text();
        if (/chat_sse_connect_started/.test(text) && /sessionId: workspace:/.test(text))
            connects += 1;
        if (/chat_sse_closed \{sessionId: workspace:/.test(text)) cleanCloses += 1;
    });

    await setupMockAuth(page, { workspaceEventsScenario: scenario });
    await setupMockSessions(page, { sessions: [{ id: SESSION_ID, title: label }] });
    await page.goto(`/workspace/workspace-1/chat/${SESSION_ID}`);
    await expect(page.getByTestId("chat-input"), "composer 挂载").toBeVisible({ timeout: 10_000 });

    const startedAt = Date.now();
    // 固定观测窗 = 量测口径本身（这里不是"等待某个状态"，而是"取一段时间内的次数"）
    await page.waitForTimeout(WINDOW_MS);
    const windowMs = Date.now() - startedAt;

    // 数的身份要能自证：每行 MEASURE_WINDOW 都能对上它的引擎，否则「能复现」会退化成「大致能复现」
    console.log(
        "MEASURE_ENV=" +
            JSON.stringify({
                browserChannel: process.env.XIHE_E2E_BROWSER_CHANNEL ?? "bundled",
                browserVersion: page.context().browser()?.version() ?? "unknown",
                windowMs: WINDOW_MS,
            }),
    );
    console.log(
        "MEASURE_WINDOW=" + JSON.stringify({ scenario: label, windowMs, connects, cleanCloses }),
    );
    // **量具自检**：0 次说明探针/夹具坏了（不是产品行为），要立刻知道
    expect(
        connects,
        "量具自检：观测窗内至少要有一次工作区 SSE 连接（0 次 = 量具坏，不是产品结论）",
    ).toBeGreaterThan(0);
    return { connects, cleanCloses };
}

test("measure: hold（对照，流永不关闭 ⇒ 预期 1 次连接）", async ({ page }) => {
    test.setTimeout(60_000); // timeout-exempt: 30 s 固定观测窗 + 挂载等待
    await measureWindow(page, { kind: "hold" }, "hold");
});

test("measure: close-soon（连上即关 ⇒ 退避，预期 [7, 11]）", async ({ page }) => {
    test.setTimeout(60_000); // timeout-exempt: 30 s 固定观测窗 + 挂载等待
    await measureWindow(page, { kind: "closeSoon" }, "close-soon");
});

test("measure: event-then-close（先发事件再关 ⇒ 预期与 close-soon 相差 ≤1）", async ({ page }) => {
    test.setTimeout(60_000); // timeout-exempt: 30 s 固定观测窗 + 挂载等待
    await measureWindow(page, { kind: "eventThenClose", ms: 200 }, "event-then-close");
});
