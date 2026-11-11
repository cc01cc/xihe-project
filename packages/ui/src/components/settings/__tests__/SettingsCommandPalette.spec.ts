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
        expect(document.body.textContent ?? "").toContain("会切换层");
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
