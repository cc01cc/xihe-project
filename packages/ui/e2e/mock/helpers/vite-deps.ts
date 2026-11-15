import type { Page } from "@playwright/test";

/**
 * task-220 ①：Vite 依赖预打包（deps optimizer）**陈旧**的探针门。
 *
 * <p>为什么需要：`504 (Outdated Optimize Dep)` 与 `Failed to fetch dynamically imported module
 * … /node_modules/.vite/deps/…` 会让动态 import 直接失败，页面停在半初始化状态，于是**任何**业务
 * 断言都会红 —— 而红的原因与产品无关。2026-11-15 实测：`workspace-members:306` 的失败就是这一类
 * （`@codemirror_*` 504 + `WorkspaceSettingsView.vue` 动态导入失败），当时被算成产品红。
 *
 * <p>**这个面此前没有任何门在看** ⇒ 属族 A（覆盖缺口）：修法是补门，不是把红写成 expected、
 * 更不是加 skip。</p>
 */

/** 三条真实形态（全部来自 [实测] 2026-11-15 的 e2e 日志）。用子串匹配而非正则：
 * 这三条都是固定文案，正则只会带来转义噪音。 */
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
