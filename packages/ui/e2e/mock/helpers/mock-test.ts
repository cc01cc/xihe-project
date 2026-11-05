/**
 * mock 车道的**公共失败门禁**（BL-318）：把"0 console error / 0 pageerror / 0 非预期 >=400"
 * 从"每条 spec 自己抄一遍"变成**一条公共 afterEach**。
 *
 * 用法（spec 只改一行 import）：
 *
 * ```ts
 * import { test, expect } from "./helpers/mock-test";
 * ```
 *
 * 门禁是 `auto` fixture：用例体结束后自动断言，失败信息里带上**全部三条通道**的原文。
 * 需要放行"故意桩出来的错误响应"时，用逐条 allow（不写整体跳过）：
 *
 * ```ts
 * test.describe("attachment failure path", () => {
 *     test.use({ mockAllow: [...DEFAULT_MOCK_ALLOW, "/attachments($|\\?)"] });
 *     ...
 * });
 * ```
 *
 * ⚠️ allow 清单是 **regex 源码字符串**而不是 `RegExp` 对象：`test.use` 的值要在 worker 之间传递，
 * Playwright 会做序列化，`RegExp` 过一手会变成 `{}`（实测报 `allow.some is not a function`）。
 * 编译放在 fixture 里做。
 *
 * 为什么必须有 allow 而不是"看到 console error 就红"：mock 车道所有出网请求都在我们自己的夹具手上，
 * **有意为之**的 403/500（例如验 `CURSOR_SELF_ONLY`、验附件上传失败）本来就要出现；不分青红皂白
 * 全绿或全红都会让门禁失去意义（`page-failures.ts` 头注释有同源说明）。
 */
import { test as base, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { collectPageFailures, expectNoPageFailures, type PageFailures } from "./page-failures";

/**
 * 默认 allow 清单（逐条写明来源；新增必须带出处，禁止"看到红就加一条"）。
 *
 * 1. Google Fonts `@import`（`src/styles/main.css`）：离线/受限网络下必然
 *    `net::ERR_CONNECTION_CLOSED`。来源：`e2e/real/plan-0508-transport-telemetry.spec.ts:105`、
 *    `e2e/real/run-trace.spec.ts:348`、`session-projections.ts` 的 `FONT_ORIGIN_FAILURE`。
 * 2. `net::ERR_ABORTED`：用例主动 `page.reload()` / 切路由时进行中的请求被浏览器取消，
 *    属**导航语义**不是失败。来源：Playwright 文档 "Network events"（navigation abort）；
 *    本 lane 首次命中见 `.local/evidence/bl-318-mock-gate.md` 批次 1。
 */
export const DEFAULT_MOCK_ALLOW: string[] = [
    String.raw`fonts\.(googleapis|gstatic)\.com`,
    String.raw`net::ERR_ABORTED`,
];

export interface MockGateFixtures {
    /** 逐条放行（regex 源码字符串，默认 `DEFAULT_MOCK_ALLOW`）。 */
    mockAllow: string[];
    /** 当前用例累积的三通道失败信号（门禁在 fixture teardown 里断言）。 */
    pageFailures: PageFailures;
}

export const test = base.extend<MockGateFixtures>({
    mockAllow: [[...DEFAULT_MOCK_ALLOW], { option: true }],
    pageFailures: [
        async (
            { page, mockAllow }: { page: Page; mockAllow: string[] },
            use: (value: PageFailures) => Promise<void>,
        ) => {
            const failures: PageFailures = collectPageFailures(page);
            const allow = (Array.isArray(mockAllow) ? mockAllow : DEFAULT_MOCK_ALLOW).map(
                (pattern) => new RegExp(pattern),
            );
            await use(failures);
            // fixture teardown 里的断言失败会把用例判红，且带上三条通道的原文。
            expectNoPageFailures(failures, allow);
        },
        { auto: true },
    ],
});

export { expect };
