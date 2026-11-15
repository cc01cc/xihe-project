/**
 * task-139 判据 ②：**未处理异常真的走通了遥测通道**（行为证据，不是 `git grep`）。
 *
 * <p>为什么这条必须存在：`installGlobalErrorTelemetry()`（`src/lib/logger.ts:523`）挂 `error` +
 * `unhandledrejection` 产出 `ui.unhandled_error` / `ui.unhandled_rejection`；接线点在
 * `src/main.ts:8`（import）与 `:49`（调用）。**「代码里有调用」不是证据** —— 只要有人挪走/删掉
 * 那两行（或 `main.ts` 的调用被前置的早退路径挡住），通道就静默失效，而静态检查永远绿。</p>
 *
 * <p>本 spec 只做一件事：**在真实浏览器里造一个真实的未处理异常**，断言 CP 遥测端点收到的批次里
 * 出现该结构化事件（`eventType` + `errorCode`）。</p>
 *
 * <p>**为什么不断言「函数被调用」**：那是接线证据，不是通道证据。断言落在**传输层收到的 payload** 上，
 * 才能同时覆盖 recordEvent → batch → flush → POST 三段。</p>
 *
 * <p>**边界（写在这里，免得下一个人以为漏检）**：
 * ① 只验形状与连通性，不验上报量/去重/会话上限 —— 那些是 `task-148`，本卡不碰（卡面边界 ③）；
 * ② `errorCode` 是**闭集**（`STRUCTURED_ERROR_CODES = TypeError|ReferenceError|RangeError|SyntaxError`，
 *    其余归一成 `UnknownError`）⇒ 用例必须用闭集内的错误类型，否则断言会落成 `UnknownError` 而看不出原因；
 * ③ 只记录错误**名**，不记录 message/stack（`logger.ts:519-522` 的隐私口径）⇒ 「首因」只能断到名字这一级，
 *    不要试图断言异常文案（那既不该被上报，也拿不到）。</p>
 */
import type { Page } from "@playwright/test";
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

/** `POST /api/v1/telemetry/logs` 的请求体（`logger.ts:344` 的 serialize）。 */
interface TelemetryBatch {
    batchId?: string;
    deviceId?: string;
    entries?: Array<Record<string, unknown>>;
}

/** 触发用的错误文案前缀：让「预期内的未捕获错误」在 BL-318 门禁里**精确放行**（不是整体跳过）。 */
const PROBE_TOKEN = "task139-probe";

test.use({
    mockAllow: [
        ...DEFAULT_MOCK_ALLOW,
        String.raw`/api/v1/telemetry/logs`,
        // 本用例**故意**制造未捕获异常 ⇒ console error / pageerror 必然出现，按 token 逐条放行。
        String.raw`task139-probe`,
    ],
});

/**
 * 拦下遥测上报并把批次原文收进数组（Node 侧），供 `expect.poll` 判「某一批里出现了目标事件」。
 *
 * <p>**注册顺序是硬约束**：`setupMockAuth` 自己也桩了遥测上报端点（通配路由，`helpers/auth.ts:1554`，
 * 回 `{status:"ok"}`），而 Playwright 的路由 handler **后注册优先** ⇒
 * 本 spec 的抓包路由必须**在 `setupMockAuth` 之后**注册，否则永远收不到请求（那次跑会红在 poll 超时上，
 * 而原因看起来像「产品没上报」，与真实原因无关）。`auth.ts:4` 的文件头也写明「spec 自己 route 一定赢」。</p>
 *
 * <p>为什么不 stub 成 204/空：500/空响应都不会让产品崩，但**批次形状**才是本卡判据 ⇒
 * 必须保存 `postDataJSON()` 原文再断言，不能只看「请求发生过」。</p>
 */
async function captureTelemetry(page: Page): Promise<TelemetryBatch[]> {
    const batches: TelemetryBatch[] = [];
    await page.route("**/api/v1/telemetry/logs", async (route) => {
        const body = route.request().postDataJSON() as TelemetryBatch;
        batches.push(body);
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ ok: true }),
        });
    });
    return batches;
}

/** 批次扁平化后按事件类型过滤（断言只关心结构化条目，不关心普通日志条目）。 */
function entriesOfType(
    batches: TelemetryBatch[],
    eventType: string,
): Array<Record<string, unknown>> {
    return batches
        .flatMap((batch) => batch.entries ?? [])
        .filter((entry) => entry.eventType === eventType);
}

test.describe("task-139 未处理异常 ⇒ 结构化遥测真的发出", () => {
    test("window unhandledrejection ⇒ 批次含 ui.unhandled_rejection + errorCode", async ({
        page,
    }) => {
        // 顺序不能反：auth.ts 已经桩了 telemetry 端点，本 spec 必须后注册才能赢（见 captureTelemetry 注释）。
        await setupMockAuth(page);
        const batches = await captureTelemetry(page);
        await page.goto("/workspace", { waitUntil: "load" });

        // 负向对照，**回溯式**而不是「立刻断言为空」：
        //   「立刻为空」是时序断言 —— 若产品在第一帧就自己发了同类事件（或上一批还在路上），它会 flaky；
        //   这里改成「触发前**已经收到**的那些批次里没有该事件」，这是对过去数据的陈述，不依赖等待。
        const beforeRejection = batches.length;
        expect(
            entriesOfType(batches.slice(0, beforeRejection), "ui.unhandled_rejection"),
        ).toHaveLength(0);

        // 真实未处理拒绝：闭集内的 RangeError（见文件头边界 ②）。
        await page.evaluate((token) => {
            void Promise.reject(new RangeError(token));
        }, PROBE_TOKEN + "-rejection");

        // flush 周期 5 s（`logger.ts:6`）⇒ 一次 poll 覆盖两个周期；不使用固定 sleep。
        await expect
            .poll(() => entriesOfType(batches, "ui.unhandled_rejection").length, {
                timeout: EXPECT_TIMEOUT_MS,
                message: "未处理 rejection 应经 recordEvent → flush 进入 CP 遥测批次",
            })
            .toBeGreaterThan(0);

        const [entry] = entriesOfType(batches, "ui.unhandled_rejection");
        expect(entry.errorCode, "首因 = 结构化错误名（闭集内原样保留）").toBe("RangeError");
        expect(entry.level).toBe("error");
        expect(String(entry.eventId ?? "")).toMatch(/^.+$/);
        // 隐私口径：只记名字，不记 message/stack。
        expect(JSON.stringify(entry)).not.toContain(PROBE_TOKEN);
    });

    test("handler 里 throw ⇒ 批次含 ui.unhandled_error + errorCode", async ({ page }) => {
        await setupMockAuth(page);
        const batches = await captureTelemetry(page);
        await page.goto("/workspace", { waitUntil: "load" });
        // 同上：回溯式负向对照（对已收到的批次下结论，不做时序断言）。
        const beforeError = batches.length;
        expect(entriesOfType(batches.slice(0, beforeError), "ui.unhandled_error")).toHaveLength(0);

        // 真实未捕获异常（不是合成事件对象）：异步 throw 才会冒到 window 的 error 事件。
        await page.evaluate((token) => {
            window.setTimeout(() => {
                throw new TypeError(token);
            }, 0);
        }, PROBE_TOKEN + "-error");

        await expect
            .poll(() => entriesOfType(batches, "ui.unhandled_error").length, {
                timeout: EXPECT_TIMEOUT_MS,
                message: "未捕获异常应经 recordEvent → flush 进入 CP 遥测批次",
            })
            .toBeGreaterThan(0);

        const [entry] = entriesOfType(batches, "ui.unhandled_error");
        expect(entry.errorCode).toBe("TypeError");
        expect(JSON.stringify(entry)).not.toContain(PROBE_TOKEN);
    });
});
