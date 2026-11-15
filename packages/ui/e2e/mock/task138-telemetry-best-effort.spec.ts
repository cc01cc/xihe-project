// timeout-exempt: 等一次 telemetry flush（FLUSH_INTERVAL = 5 s）+ 页面首屏，预算按 20 s 记（task-138）
/**
 * task-138（源 `task-64` 的「遥测失败静默」无判据）：`POST /api/v1/telemetry/logs` 的三条最小判据。
 *
 * <p>为什么单列：遥测是 **fire-and-forget** —— 真出错也没人看返回值。`task-64` 把兜底从 `200 {}` 改成
 * `404` 之后，这条上报面**最可能一条用例都不红**；那不证明它没问题，只证明**我们从没验过它**。</p>
 *
 * <p>三条判据（卡面口径）：①该上报面确实被调用（不是死代码）②请求体形状符合契约 ③**响应体不被产品
 * 依赖** —— 喂 `500` 也不崩。③最关键：它把「遥测失败必须静默」钉成约定，否则明天有人把 404 改 500
 * 又会被当成回归。</p>
 *
 * <p>**触发方式为什么是「让 `GET /api/v1/workspaces` 500」**：`/workspace` 无 tab 上下文时挂
 * `WorkspacePicker`，它 `loadWorkspaces()` 失败会走 `logger.error("Load workspaces failed: …")`
 * （`src/components/WorkspacePicker.vue:94`）⇒ 批处理入队 ⇒ 5 s 后 flush。用**产品真实错误路径**产生
 * 遥测，而不是 `page.evaluate` 直接调 logger（生产构建里 logger 不在 window 上，也没有别的稳定入口）。</p>
 *
 * <p>**为什么不判「批次里含某条具体产品日志」**（2026-11-15 实测）：遥测桩返 500 与返 200 时，
 * 客户端「是否保留队列 / 何时重发」不同 ⇒ 错误条目落在第几批、是否与后续批合并**不固定**；
 * 按文本判会让这条在变异（500→200）时先红，**遮住真正要咬住的判据 ③**（`D-1499` 同族：
 * 判据必须先红在它要测的那条性质上）。触发面由「批次非空 + 页面确实走了 workspaces 500 路径」承担。</p>
 *
 * <p>**边界（写在这里，免得下一个人以为漏检）**：遥测有**两条生产者路径** ——
 * ①`emit`（`logger.info/warn/error`）⇒ 条目 `{timestamp, level, message, data}`；
 * ②`recordEvent`（`ui.unhandled_error` / `ui.unhandled_rejection`）⇒ 条目带 `eventId`/`eventType`/`errorCode`
 * 与粗化维度，由 `installGlobalErrorTelemetry()`（`src/lib/logger.ts:523`）挂 `error`/`unhandledrejection`，
 * **且它确实在生产入口接线**（`src/main.ts:8` import、`:49` 调用）—— 本 spec 只走 ①，因为本 spec 的触发面
 * 是「产品错误路径打日志」；②的形状断言属 `task-139`（触发 `Promise.reject` ⇒ 断言批次里出现 `ui.unhandled_rejection`）。</p>
 */
import { DEFAULT_MOCK_ALLOW, expect, test } from "./helpers/mock-test";
import { setupMockAuth } from "./helpers/auth";
import { EXPECT_TIMEOUT_MS } from "../timeouts";

type Captured = { body: Record<string, unknown>; status: number };

/** 喂给 `POST /telemetry/logs` 的状态码。**变异点就是这一个常量**（500 → 200 ⇒ ③ 必红）。 */
const TELEMETRY_STUB_STATUS = 500;

/**
 * 本用例**故意**喂两个 500（`/workspaces` 触发面 + `/telemetry/logs` 判据 ③），产品会照常打
 * `logger.error` ⇒ 三条通道都会出现「预期内的失败」。按 `mock-test.ts` 的既定形态**逐条放行**
 * （regex 源码字符串，`test.use` 会序列化，传 `RegExp` 会变成 `{}`），不做整体跳过。
 */
test.use({
    mockAllow: [
        ...DEFAULT_MOCK_ALLOW,
        String.raw`/api/v1/workspaces`,
        String.raw`/api/v1/telemetry/logs`,
        String.raw`Load workspaces for the sidebar groups failed`,
    ],
});

test.describe("task-138 遥测上报：fire-and-forget 三判据", () => {
    test("workspaces 500 ⇒ 产生一次 telemetry 上报；喂 500 不崩、不重试", async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));

        await setupMockAuth(page);

        // ① 触发面：产品真实错误路径（WorkspacePicker.loadWorkspaces 失败 ⇒ logger.error）。
        await page.route("**/api/v1/workspaces", async (route) => {
            await route.fulfill({
                status: 500,
                contentType: "application/problem+json",
                body: JSON.stringify({
                    code: "MOCK_WORKSPACES_FAILED",
                    detail: "forced by task-138",
                }),
            });
        });

        // 判据 ③ 的一半：**我们喂 500**，并记录产品实际拿到什么。
        const captured: Captured[] = [];
        // 3a 的依据必须是**浏览器实际收到的状态码**，不能是我们自己写死的常量 —— 否则
        // 「变异 500→200」时断言恒绿，等于判据没咬住（2026-11-15 首轮变异实测：变异打歪了）。
        const telemetryResponseStatuses: number[] = [];
        page.on("response", (response) => {
            if (response.url().includes("/api/v1/telemetry/logs")) {
                telemetryResponseStatuses.push(response.status());
            }
        });
        await page.route("**/api/v1/telemetry/logs", async (route) => {
            captured.push({
                body: (route.request().postDataJSON() ?? {}) as Record<string, unknown>,
                status: TELEMETRY_STUB_STATUS,
            });
            await route.fulfill({
                status: TELEMETRY_STUB_STATUS,
                contentType: "application/problem+json",
                body: JSON.stringify({ code: "MOCK_TELEMETRY_REJECTED", detail: "task-138" }),
            });
        });

        await page.goto("/workspace");

        // ── 判据 ①：上报面确实被调用（flush 间隔 5 s，留 3 倍余量）。
        await expect
            .poll(() => captured.length, { timeout: EXPECT_TIMEOUT_MS * 3 })
            .toBeGreaterThan(0);

        // ── 判据 ②：请求体形状（emit 路径：batchId/deviceId/entries[{level,message,…}]）。
        const payload = captured[0]!.body;
        expect(typeof payload.batchId, "batchId 必须是字符串").toBe("string");
        expect(Array.isArray(payload.entries), "entries 必须是数组").toBe(true);
        const entries = payload.entries as Record<string, unknown>[];
        expect(entries.length, "至少一条遥测条目").toBeGreaterThan(0);
        for (const entry of entries) {
            expect(["debug", "info", "warn", "error"]).toContain(entry.level);
            expect(typeof entry.message).toBe("string");
            expect(typeof entry.timestamp).toBe("number");
        }

        // ── 判据 ③：响应体/状态不被产品依赖（我们发的是 500）。
        // 3a **本用例喂的确实是失败响应**（500）：没有这条，③ 就是个「给什么都绿」的空断言 ——
        //    变异（把下面 stub 的 500 改成 200）必须让这条红。
        //     右侧必须是**字面量 500**：写成 `TELEMETRY_STUB_STATUS` 就等于拿常量比自己，变异后
        //     200 === 200 依旧绿（2026-11-15 第二次变异实测踩到，D-1499 同族）。
        expect(telemetryResponseStatuses[0], "③ 的前提：浏览器实际收到的遥测响应必须是 500").toBe(
            500,
        );
        // 3b 产品未抛未捕获异常（telemetry 失败必须静默）。
        expect(pageErrors, `遥测 500 不得产生 pageerror；实际：${pageErrors.join(" | ")}`).toEqual(
            [],
        );
        // 3c 页面仍可用：应用外壳仍在（挂载出的 data-testid 节点数 > 5）⇒ 交互层没被遥测失败拖垮。
        //    **不用 picker 的 role=alert**：/workspace 路由下挂的是侧栏分组（WorkspaceSessionGroups），
        //    picker 只在「无 tab 上下文」时才挂 —— 拿它当判据会在正确产品行为上判红。
        await expect
            .poll(() => page.evaluate(() => document.querySelectorAll("[data-testid]").length), {
                timeout: EXPECT_TIMEOUT_MS,
            })
            .toBeGreaterThan(5);
        // 3d best-effort 不重试：同一批只发一次（发 429 才退回 60 s 冷却，500 不触发重试）。
        expect(captured.length, "遥测失败不得立刻重试（best-effort 语义）").toBe(1);
    });
});
