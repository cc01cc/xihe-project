import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import { describe, expect, it } from "vitest";

import WorkspaceContainerSwitcher from "../WorkspaceContainerSwitcher.vue";

/**
 * task-174（S2b）/ `D-1545`：窄屏切换控件的**形状**判据（`D-1545` 明写「先落形状与单测，
 * 真正的窄屏渲染在移动壳卡里接通」）。
 *
 * 判据：① 两个 `role=tab` + `aria-selected` 恰好一个为 true；② 点另一个 ⇒ emit 新值；
 * ③ 键盘（方向键）可达 —— 由 reka `Tabs` 的 roving focus 提供，这里钉「焦点真的会挪」。
 */
const i18n = createI18n({
    legacy: false,
    locale: "zh-CN",
    messages: {
        "zh-CN": {
            workspace: {
                containerMain: "主栏",
                containerRight: "右栏容器",
                containerSwitcherLabel: "显示哪一栏",
            },
        },
    },
});

function mountSwitcher(activeColumn: "main" | "right") {
    return mount(WorkspaceContainerSwitcher, {
        props: { activeColumn },
        attachTo: document.body,
        global: { plugins: [i18n] },
    });
}

describe("WorkspaceContainerSwitcher（D-1545：窄屏可切换单栏）", () => {
    it("两个 tab + aria-selected 恰好一个 true（当前栏）", () => {
        const wrapper = mountSwitcher("main");
        const tabs = wrapper.findAll('[role="tab"]');
        expect(tabs).toHaveLength(2);
        expect(tabs.filter((tab) => tab.attributes("aria-selected") === "true")).toHaveLength(1);
        expect(
            wrapper
                .get('[data-testid="workspace-container-switcher-main"]')
                .attributes("aria-selected"),
        ).toBe("true");
        expect(
            wrapper
                .get('[data-testid="workspace-container-switcher-right"]')
                .attributes("aria-selected"),
        ).toBe("false");
    });

    it("点「右栏」⇒ emit 新值（切换只改可见性，归属由 containerOf 保证不变）", async () => {
        const wrapper = mountSwitcher("main");
        await wrapper.get('[data-testid="workspace-container-switcher-right"]').trigger("click");
        expect(wrapper.emitted("update:activeColumn")?.[0]).toEqual(["right"]);
    });

    it("键盘可达所依赖的结构：role=tablist + role=tab（方向键/roving 由 reka 提供）", () => {
        // 为什么不在这里断言方向键与 tabindex：jsdom 里 reka 的 roving 不建立 tab stop（实测两个 tab
        // 的 tabindex 都是 -1，浏览器里由 focus 事件驱动），本仓既有口径是「交互行为用 Playwright 验证」
        // （AGENTS.md）。真正的键盘判据落在移动壳卡接通后的 e2e；本文件只钉**结构**：tablist/tab 存在、
        // aria-selected 唯一，切换走 emit。
        const wrapper = mountSwitcher("right");
        expect(wrapper.find('[role="tablist"]').exists()).toBe(true);
        expect(wrapper.findAll('[role="tab"]')).toHaveLength(2);
    });
});
