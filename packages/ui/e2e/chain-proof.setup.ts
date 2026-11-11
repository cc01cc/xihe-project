/**
 * task-80：**链路自证**（Playwright `globalSetup`）。
 *
 * 判据不是"跑起来绿了"，而是**先拿到链路证据再允许跑**：
 * 1. 按 `resolveExpectedChain()` 得到本次**声明**的链路（显式声明优先，否则从 `XIHE_UI_MOCK_API` 推导）；
 * 2. fetch 一次 `/settings/user/user-preference`，从响应 HTML 判断**实际**链路；
 * 3. 两者不一致 ⇒ **整轮 fail-fast**，并打印"当前服务的是哪个 HTML / 期望哪个 / 怎么改"。
 *
 * 为什么值得一次额外请求（~几十 ms）：不加这一步，`mock` 车道的"绿"可能来自另一条链路
 * （`index.html`），而报告里没有任何字段能说明这件事 —— 与 `task-75` 的"绿灯骗人"同一类病，
 * 只是这次骗人的不是断言，是**被测对象不在场**。
 */
import {
    CHAIN_PROBE_PATH,
    INDEX_CHAIN_MARKERS,
    PREVIEW_CHAIN_MARKERS,
    detectChain,
    resolveExpectedChain,
} from "./helpers/chain";

const CHAIN_HINT: Record<"index" | "preview", string> = {
    index: "index.html（产品入口 + 预涂主题脚本；mock 车道的网络层由 page.route 桩提供）",
    preview:
        "preview-real.html（mock 外壳：注入 mock 登录态、强制 zh-CN；由 XIHE_UI_MOCK_API=1 的 vite 中间件改写入口）",
};

export default async function chainProof(): Promise<void> {
    const expected = resolveExpectedChain();
    const base = (
        process.env.XIHE_E2E_BASE_URL ?? `http://localhost:${process.env.XIHE_UI_PORT || "12630"}`
    ).replace(/\/$/, "");
    const url = `${base}${CHAIN_PROBE_PATH}`;

    let status: number;
    let html: string;
    try {
        const response = await fetch(url, { redirect: "manual" });
        status = response.status;
        html = await response.text();
    } catch (error) {
        throw new Error(
            [
                `[chain-proof] 拿不到链路证据 = 不跑：请求 ${url} 失败（${(error as Error).message}）`,
                `  期望链路: ${expected.chain}（来源 ${expected.source}）`,
                `  常见原因: webServer 没起来 / XIHE_UI_PORT 指错端口 / 该端口上是别的 lane 的 server`,
            ].join("\n"),
        );
    }

    const actual = detectChain(html);
    const verdict = `[chain-proof] 期望=${expected.chain} 实际=${actual.chain} status=${status} url=${url} 标题=${JSON.stringify(actual.title)} 命中=${JSON.stringify(actual.matched)}`;
    // 一律打印：跑绿了也要让人从日志里读得到"这次跑在哪条链路上"
    console.log(verdict);

    if (actual.chain === expected.chain) return;

    const actualHint =
        actual.chain === "unknown"
            ? "无法识别的 HTML（既无 index 特征也无 preview 特征；可能是登录页/错误页/别的应用）"
            : CHAIN_HINT[actual.chain];

    throw new Error(
        [
            "[chain-proof] 链路不符 = 不跑（否则「绿」会归因到错误的被测对象上）",
            `  声明链路: ${expected.chain}（来源 ${expected.source}）—— ${CHAIN_HINT[expected.chain]}`,
            `  实际链路: ${actual.chain} —— ${actualHint}`,
            `  证据: status=${status} 标题=${JSON.stringify(actual.title)} 命中特征=${JSON.stringify(actual.matched)}`,
            `  index 特征: ${JSON.stringify(INDEX_CHAIN_MARKERS)}`,
            `  preview 特征: ${JSON.stringify(PREVIEW_CHAIN_MARKERS)}`,
            `  怎么改: 想跑 preview 壳 ⇒ 让 vite 带 XIHE_UI_MOCK_API=1（或设 XIHE_E2E_EXPECT_CHAIN=preview 由 config 注入）；`,
            `          想跑 index 入口 ⇒ 去掉 XIHE_UI_MOCK_API / 显式 XIHE_E2E_EXPECT_CHAIN=index。`,
        ].join("\n"),
    );
}
