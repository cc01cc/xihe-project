import type { Page } from "@playwright/test";

/**
 * task-220 ①：**探测一类静默环境失败** —— Vite 依赖预打包（deps optimizer）陈旧时的
 * `504 (Outdated Optimize Dep)` 与 `Failed to fetch dynamically imported module … /node_modules/.vite/deps/…`。
 *
 * <p>**价值主张（口径已按 `D-1599` 收窄，别读成「预防了那次 504」）**：这类失败会让动态 import 直接
 * 失败、页面停在半初始化状态，于是**任何**业务断言都会红，而红的原因与产品无关 —— 门的作用是让这类
 * 红**归因可辨**，不是断言历史上某一次红就是它。</p>
 *
 * <p>**这条门证不了「当初那次红是 504」**：`D-1558`（15:26）曾把 `workspace-members:306` 归为环境
 * (d)，`D-1559`（15:35，九分钟后）自我推翻为能力夹具缺口 (a)；且 `.tmp/xh` 与 `internal/A03-xihe` 里
 * **没有任何原始 504 响应或服务端日志**可复算。⇒ 「门能红」与「它挡的是当初那件事」是两件事
 * （`D-1599`：按错误归因建的门属第三种状态）。</p>
 *
 * <p>**待排除的替代解释（不写结论）**：同批注记里还有「mock 车道不要用同一 `XIHE_UI_PORT` 跑并发
 * job」。若那次 504 实为**并发 Vite 抢端口 / 优化器共享**所致，正确量具是端口或并发守卫，而不是 deps
 * 新鲜度 —— 本门在那个假设下依然有效（它探测的是现象），但**归因解释要换**。</p>
 *
 * <p>这个面此前没有任何门在看 ⇒ 属族 A（覆盖缺口）：修法是补门，不是把红写成 expected、更不是加
 * skip。</p>
 */

/** 三条形态取自 2026-11-15 观测到的 504 / 动态导入失败文案（**原始日志已不可得**，见上：那次归因
 * 已被 `D-1559` 推翻）。用子串匹配而非正则：这三条都是固定文案，正则只会带来转义噪音。 */
const STALE_MARKERS = ["Outdated Optimize Dep", "dynamically imported module", ".vite/deps/"];

/** 这条失败信号是否属于「依赖预打包陈旧」。 */
export function isStaleDepsFailure(entry: string): boolean {
    const text = entry.toLowerCase();
    return STALE_MARKERS.some((marker) => text.includes(marker.toLowerCase()));
}

/** 从一组失败信号里挑出陈旧依赖条目（保持原序，便于逐条打印）。 */
export function pickStaleDepsFailures(entries: string[]): string[] {
    return entries.filter(isStaleDepsFailure);
}

export interface WarmUpResult {
    /** 预热期间观测到的陈旧依赖失败条数。 */
    staleSeen: number;
    /** 是否因陈旧依赖触发过一次性 reload。 */
    reloaded: boolean;
    /** reload 之后是否仍有陈旧依赖失败（>0 ⇒ 一次性 reload 不够，必须报环境问题）。 */
    staleAfterReload: number;
}

/**
 * 起跑前预热：打开页面一次，若命中陈旧依赖失败则**重载一次**并复测。
 *
 * <p>为什么一次 reload 够：Vite 首次命中陈旧 hash 时会重新预打包，下一次导航拿到的就是新 hash。
 * **若 reload 后仍然 504**，那不是竞态而是真坏（依赖损坏/权限/磁盘），此时
 * `staleAfterReload > 0`，调用方必须按环境失败上报，不能继续断言把红算成产品缺陷。</p>
 */
export async function warmUpViteDeps(page: Page, url: string): Promise<WarmUpResult> {
    const seen: string[] = [];
    const record = (entry: string) => {
        if (isStaleDepsFailure(entry)) seen.push(entry);
    };
    const onResponse = (response: { status(): number; url(): string }) => {
        if (response.status() === 504) record("504 " + response.url());
    };
    const onConsole = (message: { text(): string }) => {
        record(message.text());
    };
    page.on("response", onResponse);
    page.on("console", onConsole);
    try {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        if (seen.length === 0) return { staleSeen: 0, reloaded: false, staleAfterReload: 0 };
        const staleSeen = seen.length;
        seen.length = 0;
        await page.reload({ waitUntil: "domcontentloaded" });
        return { staleSeen, reloaded: true, staleAfterReload: seen.length };
    } finally {
        page.off("response", onResponse);
        page.off("console", onConsole);
    }
}

/** 一行读数（成功时也打印，便于复核）。 */
export function formatWarmUp(result: WarmUpResult): string {
    return (
        "[vite-deps] staleSeen=" +
        String(result.staleSeen) +
        " reloaded=" +
        String(result.reloaded) +
        " staleAfterReload=" +
        String(result.staleAfterReload)
    );
}
