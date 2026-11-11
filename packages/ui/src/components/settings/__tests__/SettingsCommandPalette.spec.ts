import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import SettingsCommandPalette from "../SettingsCommandPalette.vue";
import { i18n } from "../../../i18n";
import {
    DOMAIN_LABEL_KEY,
    domainsForLayer,
    settingsDomainPath,
    type SettingsLayer,
} from "../../../lib/settingsIa";
import { SUPPORTED_LOCALES } from "../../../i18n/locale";

/**
 * PLAN-0762 T3.4：⌘K 搜配置域。
 *
 * 本 spec 钉三件最容易退化的东西：
 * ① **域清单来自矩阵**：条目数必须恒等于 `domainsForLayer(layer).length`，且每个域都在结果里
 *    —— 任何人想「顺手加一条硬编码入口」都会让这条红；
 * ② **跨层显式**：其他层条目必须带目标层徽标（不静默换层）；
 * ③ **空态有出口**：无匹配时给「清除搜索 / 打开本层默认页」两个按钮，不是只显示空列表。
 *
 * `CommandDialog` 走 `DialogPortal` → Teleport 到 `document.body`，所以面板内容不在 `wrapper`
 * 的子树里；这里用 `attachTo` + `document` 查询（stub 掉 Teleport 会把内容整块吞掉，试过）。
 *
 * jsdom 不算键盘可达的真机证据（card：↑↓/Enter/Esc 要真机验）；这里只钉「按键打开/关闭的分支」
 * 与「条目来源」，真机读数在证据 README。
 */
const routes = [
    { path: "/settings/:layer/:domain", component: { template: "<div />" } },
    { path: "/settings", component: { template: "<div />" } },
    // 兜住初始空地址（否则 vue-router 每次挂载都打一条 R0004 噪声）
    { path: "/:pathMatch(.*)*", component: { template: "<div />" } },
];

let wrapper: ReturnType<typeof mount> | undefined;

function mountPalette(layer: SettingsLayer, open = true) {
    const router = createRouter({ history: createMemoryHistory(), routes });
    wrapper = mount(SettingsCommandPalette, {
        props: { layer, open },
        attachTo: document.body,
        global: { plugins: [i18n, router] },
    });
    return { wrapper, router };
}

function q<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    return document.body.querySelector<T>(selector);
}

function qa(selector: string): HTMLElement[] {
    return Array.from(document.body.querySelectorAll<HTMLElement>(selector));
}

async function click(selector: string) {
    const node = q(selector);
    if (!node) throw new Error(`no node for ${selector}`);
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
}

type UiLocale = "zh-CN" | "en-US";

function pressK(modifier: "meta" | "ctrl") {
    document.dispatchEvent(
        new KeyboardEvent("keydown", {
            key: "k",
            metaKey: modifier === "meta",
            ctrlKey: modifier === "ctrl",
            bubbles: true,
        }),
    );
}

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView = vi.fn<() => void>();
});

afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// task-46：搜索面必须是「当前语言标签 ∪ 另一语言标签 ∪ 域名 key」。
// 期望集一律由 `domainsForLayer(layer)`（矩阵）+ i18n 两侧 message 现算 —— **不写死条数**：
// 域增减时这里跟着动，不会变成假红（域变少）或假绿（域变多但没人测）。
// ---------------------------------------------------------------------------

function labelIn(localeName: string, key: string): string {
    const messages = i18n.global.getLocaleMessage(localeName) as Record<string, unknown>;
    const value = key
        .split(".")
        .reduce<unknown>(
            (acc, part) => (acc as Record<string, unknown> | undefined)?.[part],
            messages,
        );
    return typeof value === "string" ? value : "";
}

function otherLocaleOf(uiLocale: UiLocale): string {
    return SUPPORTED_LOCALES.find((item) => item !== uiLocale) ?? uiLocale;
}

/** 契约：任一字段（当前语言标签 / 另一语言标签 / 域名 key）**包含**该查询即命中。 */
function expectedHits(layer: SettingsLayer, query: string, uiLocale: UiLocale): string[] {
    const other = otherLocaleOf(uiLocale);
    const needle = query.toLowerCase();
    return domainsForLayer(layer).filter((domain) => {
        const labelKey = DOMAIN_LABEL_KEY[domain];
        return [labelIn(uiLocale, labelKey), labelIn(other, labelKey), domain].some((field) =>
            field.toLowerCase().includes(needle),
        );
    });
}

async function withLocale<T>(locale: UiLocale, run: () => Promise<T>): Promise<T> {
    const previous = i18n.global.locale.value as UiLocale;
    i18n.global.locale.value = locale;
    await flushPromises();
    try {
        return await run();
    } finally {
        i18n.global.locale.value = previous;
        await flushPromises();
    }
}

async function typeSearch(value: string) {
    const input = q<HTMLInputElement>('[data-slot="command-input"]');
    expect(input).toBeTruthy();
    input!.value = value;
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushPromises();
}

function itemText(testid: string): string {
    const node = q(`[data-testid="${testid}"]`);
    return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("SettingsCommandPalette 搜索面（task-46 中英互搜）", () => {
    it("中文界面输 `log` 必须命中「日志」（期望集由矩阵算出，不写死条数）", async () => {
        await withLocale("zh-CN", async () => {
            mountPalette("instance");
            await flushPromises();
            await typeSearch("log");

            const expected = expectedHits("instance", "log", "zh-CN");
            // 前提：矩阵里确实有 logging（否则这条测不到东西，属测试自检）
            expect(expected).toContain("logging");
            const shown = qa('[data-testid^="commandk-item-instance:"]').map((el) =>
                (el.getAttribute("data-testid") ?? "").replace("commandk-item-instance:", ""),
            );
            expect(shown.sort()).toEqual(
                expected.filter((domain) => domainsForLayer("instance").includes(domain)).sort(),
            );
            // 命中项显示的是**中文标签**，不是 key
            expect(itemText("commandk-item-instance:logging")).toContain("日志");
        });
    });

    it("英文界面输「日志」必须命中 logging", async () => {
        await withLocale("en-US", async () => {
            mountPalette("instance");
            await flushPromises();
            await typeSearch("日志");

            expect(expectedHits("instance", "日志", "en-US")).toContain("logging");
            const item = q('[data-testid="commandk-item-instance:logging"]');
            expect(item).toBeTruthy();
            // 英文界面显示英文标签，中文标签只作搜索别名
            expect(itemText("commandk-item-instance:logging")).toContain("Logging");
        });
    });

    it("同一域被 key 与标签同时命中时只有一条（不得出现重复条目）", async () => {
        await withLocale("zh-CN", async () => {
            mountPalette("instance");
            await flushPromises();

            // "log" 同时命中 域名 key `logging` 与英文标签 `Logging` ⇒ 仍只能 1 条
            await typeSearch("log");
            expect(qa('[data-testid="commandk-item-instance:logging"]')).toHaveLength(1);

            await typeSearch("logging");
            expect(qa('[data-testid="commandk-item-instance:logging"]')).toHaveLength(1);

            await typeSearch("日志");
            expect(qa('[data-testid="commandk-item-instance:logging"]')).toHaveLength(1);
        });
    });

    it("别名对像素与无障碍隐身：sr-only + aria-hidden，可见文本里没有 key", async () => {
        await withLocale("zh-CN", async () => {
            mountPalette("instance");
            await flushPromises();

            const aliases = qa("[data-commandk-alias]");
            expect(aliases.length).toBeGreaterThan(0);
            for (const node of aliases.slice(0, 5)) {
                expect(node.className).toContain("sr-only");
                expect(node.getAttribute("aria-hidden")).toBe("true");
            }
            // 可见标签仍是纯中文（= 当前 locale 的标签，不写死文案）：条目里除别名外不得出现域名 key
            const item = q('[data-testid="commandk-item-instance:logging"]');
            const labelSpan = item?.querySelector("span:not([data-commandk-alias])");
            expect((labelSpan?.textContent ?? "").trim()).toBe(
                i18n.global.t(DOMAIN_LABEL_KEY.logging),
            );
            expect(labelSpan?.textContent ?? "").not.toContain("logging");
        });
    });
});

describe("SettingsCommandPalette（T3.4 ⌘K 搜配置域）", () => {
    it("⌘K / Ctrl+K 打开、已开时再按则关闭", () => {
        mountPalette("instance", false);
        pressK("meta");
        expect(wrapper!.emitted("update:open")?.[0]).toEqual([true]);
        pressK("ctrl");
        expect(wrapper!.emitted("update:open")?.[1]).toEqual([true]);
    });

    it("已打开时按 ⌘K 收起，且不响应其他键（⌘B 归 vendor SidebarProvider）", () => {
        mountPalette("instance", true);
        pressK("meta");
        expect(wrapper!.emitted("update:open")?.[0]).toEqual([false]);
        document.dispatchEvent(
            new KeyboardEvent("keydown", { key: "b", metaKey: true, bubbles: true }),
        );
        expect(wrapper!.emitted("update:open")).toHaveLength(1);
    });

    it("本层条目恒等于矩阵域集合，且每条都指向 settingsDomainPath", async () => {
        const layer: SettingsLayer = "instance";
        mountPalette(layer);
        await flushPromises();

        const matrix = domainsForLayer(layer);
        const items = qa('[data-testid^="commandk-item-instance:"]');
        expect(items).toHaveLength(matrix.length);
        for (const domain of matrix) {
            const item = q(`[data-testid="commandk-item-instance:${domain}"]`);
            expect(item, domain).toBeTruthy();
            expect(item!.textContent ?? "").toContain(i18n.global.t(DOMAIN_LABEL_KEY[domain]));
        }
    });

    it("其他层条目单独成组并带目标层徽标（跨层显式，不静默换层）", async () => {
        mountPalette("user");
        await flushPromises();

        // user 层没有 logging ⇒ 它只能以「其他层 · 实例」形态出现，并带徽标
        expect(q('[data-testid="commandk-item-instance:logging"]')).toBeTruthy();
        const badge = q('[data-testid="commandk-badge-instance:logging"]');
        expect(badge).toBeTruthy();
        expect(badge!.textContent ?? "").toContain("实例配置");
        // task-43：「跨层」只由**跟随条目**的徽标表达一次；分组标题不再挂「（会切换层）」括注。
        // 反向断言是这条的钉子 —— 谁把括注加回去，这里就红（语义重复属 D-926 五维 P1）。
        expect(document.body.textContent ?? "").not.toContain("会切换层");
        expect(document.body.textContent ?? "").not.toContain("switches layer");
    });

    it("选中条目走 settingsDomainPath 并关闭面板", async () => {
        const { router } = mountPalette("instance");
        await flushPromises();

        await click('[data-testid="commandk-item-instance:rag"]');

        expect(wrapper!.emitted("update:open")?.at(-1)).toEqual([false]);
        expect(router.currentRoute.value.path).toBe(settingsDomainPath("instance", "rag"));
    });

    it("空态给两个出口，清除搜索后回到列表", async () => {
        mountPalette("instance");
        await flushPromises();

        const input = q<HTMLInputElement>('[data-slot="command-input"]');
        expect(input).toBeTruthy();
        input!.value = "zzz-no-such-domain";
        input!.dispatchEvent(new Event("input", { bubbles: true }));
        await flushPromises();

        const empty = q('[data-slot="command-empty"]');
        expect(empty).toBeTruthy();
        expect(empty!.textContent ?? "").toContain("没有匹配的配置域");
        expect(q('[data-testid="commandk-clear"]')).toBeTruthy();
        expect(q('[data-testid="commandk-default-page"]')).toBeTruthy();

        await click('[data-testid="commandk-clear"]');
        await flushPromises();
        expect(qa('[data-testid^="commandk-item-instance:"]')).toHaveLength(
            domainsForLayer("instance").length,
        );
    });
});
