import { beforeAll, describe, expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";

import SearchableCombobox from "../SearchableCombobox.vue";
import type { SearchableComboboxOption } from "../types";

/**
 * task-215 · combobox 弹层的 Tab 停靠点契约。
 *
 * 背景（真栈实测，见 internal/A03-xihe/evidence/2026-11-21-combobox-a11y/README.md §12）：
 * Chrome 130 起「没有可聚焦子项的可滚动容器」默认进入顺序焦点导航，于是 Tab 第一次会停在
 * `div[data-slot="combobox-viewport"]`（role=presentation），层不关；第二次 Tab 才离开。
 * 组件给出的对策是给 viewport 显式 `tabindex="-1"`：官方文档明确「negative tabindex ⇒ the scroller
 * will be skipped」，真栈对照读数也复现（去掉起始停靠 / 改 tabindex=0 又停回）。
 *
 * 为什么这里断言的是 DOM 契约而不是「按 Tab 后 document.activeElement」：
 * jsdom **不实现顺序焦点导航**（Tab 不移动焦点），任何「按 Tab 再看 activeElement」的断言在 jsdom
 * 里都会恒真 —— 那是空断言。行为侧证据由真栈探针提供（同目录 approval 读数），本 spec 锁的是
 * 让浏览器跳过它的那条属性 + 它成立的前提（层内除搜索框外没有顺序可聚焦元素）。
 */
const OPTIONS: SearchableComboboxOption[] = Array.from({ length: 24 }, (_, i) => ({
    value: `status-${i}`,
    label: `状态 ${i}`,
}));

const Harness = {
    components: { SearchableCombobox },
    data: () => ({ value: "", options: OPTIONS }),
    template: `<SearchableCombobox v-model="value" :options="options" placeholder="全部状态" testid="tabstop-combobox" />`,
};

beforeAll(() => {
    // reka 的 item 高亮走 scrollIntoView，jsdom 没实现。
    Element.prototype.scrollIntoView = () => {};
});

async function openLayer() {
    const wrapper = mount(Harness, { attachTo: document.body });
    await wrapper.find('[data-testid="tabstop-combobox"]').trigger("click");
    await flushPromises();
    await nextTick();
    return wrapper;
}

describe("task-215 · combobox 弹层不吞 Tab", () => {
    it('viewport 显式 tabindex="-1"（Chrome 130 起可滚动容器会被自动纳入 Tab 序，必须显式排除）', async () => {
        const wrapper = await openLayer();
        const viewport = document.querySelector('[data-slot="combobox-viewport"]');
        expect(viewport, "弹层没挂出来").not.toBeNull();
        expect(viewport?.getAttribute("role")).toBe("presentation");
        // 这条就是 task-215 的回归点：删掉组件里的 tabindex="-1"，这里立刻红。
        expect(viewport?.getAttribute("tabindex")).toBe("-1");
        wrapper.unmount();
    });

    it("层内除搜索框外没有顺序可聚焦元素（这才是浏览器把容器当 Tab 落点的前提）", async () => {
        const wrapper = await openLayer();
        const layer = document.querySelector('[role="listbox"]');
        expect(layer, "弹层没挂出来").not.toBeNull();
        // 显式 tabindex 且不为 -1 ⇒ 进入 Tab 序。
        expect(layer?.querySelectorAll('[tabindex]:not([tabindex="-1"])')).toHaveLength(0);
        // 原生的顺序可聚焦元素：只允许搜索框一个。
        const sequential = layer?.querySelectorAll(
            'a[href], button, input, select, textarea, summary, [contenteditable="true"]',
        );
        expect(sequential).toHaveLength(1);
        expect(sequential?.[0]?.getAttribute("data-testid")).toBe("searchable-combobox-input");
        wrapper.unmount();
    });
});
