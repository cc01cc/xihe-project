/**
 * task-80：**链路自证**的共用逻辑（config 与 globalSetup 都从这里取，避免两处各写一份判断）。
 *
 * 背景（`green-light-audit.md` §A4.3）：mock 车道的 `webServer.command` 是 `pnpm dev`，
 * 而 vite 的 mock 中间件只在 `XIHE_UI_MOCK_API=1` 时挂载（`src/preview/mock/api-server.ts:13/154`）。
 * 那个中间件同时决定 `/settings|/workspace/**` 的 HTML 入口被改写成 `preview-real.html`。
 * ⇒ **同一个命令，两种完全不同的被测入口**：
 *
 * - `index` 链路：`/settings/**` 由 `index.html` 承载（有预涂主题脚本），网络层由 Playwright
 *   `page.route` 桩提供（`e2e/mock/helpers/auth.ts` 里 243 处 `page.route`）；
 * - `preview` 链路：`/settings/**` 由 `preview-real.html` 承载（有 mock 登录态注入 + 语言强制 zh-CN），
 *   网络层既可用 vite 中间件也可被 `page.route` 覆盖。
 *
 * 两条链路上"持久化/刷新后仍 X"类断言的结论**可能相反**（`task-75` 红②第一次 6 passed 就是这个），
 * 所以 e2e 不允许"不知道自己跑在哪条链路上"：本文件负责**声明期望链路**，setup 负责**证明实际链路**。
 */

export type E2eChain = "index" | "preview";

/** 探针页：mock 中间件正是按 `/settings/**` 前缀改写 HTML 入口的。 */
export const CHAIN_PROBE_PATH = "/settings/user/user-preference";

/** `preview-real.html` 独有：内联脚本里的 mock token 字面量 + 页面标题。 */
export const PREVIEW_CHAIN_MARKERS = ["mock-lane-token", "真实 UI · mock 数据预览"] as const;

/** `index.html` 独有：产品标题 + 应用挂载点。 */
export const INDEX_CHAIN_MARKERS = ["xihe - AI Agent Platform", 'id="app"'] as const;

export interface ChainDetection {
    chain: E2eChain | "unknown";
    matched: string[];
    title: string;
}

/** 从响应体判断实际链路。两个都不匹配 = `unknown`（拿不到链路证据）。 */
export function detectChain(html: string): ChainDetection {
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
    const previewHit = PREVIEW_CHAIN_MARKERS.filter((marker) => html.includes(marker));
    const indexHit = INDEX_CHAIN_MARKERS.filter((marker) => html.includes(marker));

    if (previewHit.length > 0) {
        return { chain: "preview", matched: previewHit, title };
    }
    // index 链路：命中产品标题，且**完全没有** preview 特征（避免"两个都像"时误判）
    if (indexHit.length === INDEX_CHAIN_MARKERS.length) {
        return { chain: "index", matched: indexHit, title };
    }
    return { chain: "unknown", matched: [...previewHit, ...indexHit], title };
}

export interface ExpectedChain {
    chain: E2eChain;
    /** 声明来源，进日志：是"人显式声明"还是"从 XIHE_UI_MOCK_API 推导"。 */
    source: string;
}

/**
 * 期望链路：**显式声明优先**，否则从"中间件是否启用"推导（这正是决定 HTML 的那个开关）。
 * `XIHE_E2E_EXPECT_CHAIN` 只用于"声明"，不改变服务端行为 —— 这样它才能用于反向验证。
 */
export function resolveExpectedChain(env: NodeJS.ProcessEnv = process.env): ExpectedChain {
    const declared = env.XIHE_E2E_EXPECT_CHAIN?.trim();
    if (declared) {
        if (declared !== "index" && declared !== "preview") {
            throw new Error(
                `[chain-proof] XIHE_E2E_EXPECT_CHAIN=${JSON.stringify(declared)} 非法：只接受 "index" | "preview"`,
            );
        }
        return { chain: declared, source: "XIHE_E2E_EXPECT_CHAIN" };
    }
    return {
        chain: env.XIHE_UI_MOCK_API === "1" ? "preview" : "index",
        source: `derive:XIHE_UI_MOCK_API=${env.XIHE_UI_MOCK_API ?? "(未设)"}`,
    };
}

/** webServer 该给子进程什么值，才能让"实际链路"与"期望链路"一致。 */
export function mockApiEnvFor(chain: E2eChain): string {
    return chain === "preview" ? "1" : "0";
}
