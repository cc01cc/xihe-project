import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { i18n } from "../../../../i18n";
import ResourcePaneLoading from "../ResourcePaneLoading.vue";

/**
 * 资源页异步面板的加载占位（task-10 / batch-2 ①）。
 *
 * <p>判据只有三条，但每条都对应一个曾经的空白症状：①**有出口** —— 至少有一句「正在做什么」，
 * 不是纯白；②**读屏可见** —— `role=status` + `aria-live=polite`，骨架 `aria-hidden` 不念噪音；
 * ③**占位不冒充内容** —— 骨架块不带任何文本，避免被当成真实数据。</p>
 */
function mountLoading() {
    return mount(ResourcePaneLoading, { global: { plugins: [i18n] } });
}

describe("ResourcePaneLoading", () => {
    it("给出「加载中」文案与固定 testid（不再是一片空白）", () => {
        const wrapper = mountLoading();
        const box = wrapper.get('[data-testid="resource-pane-loading"]');
        expect(box.text()).toContain("加载中");
    });

    it("对读屏是状态播报，不是隐形元素", () => {
        const wrapper = mountLoading();
        const box = wrapper.get('[data-testid="resource-pane-loading"]');
        expect(box.attributes("role")).toBe("status");
        expect(box.attributes("aria-live")).toBe("polite");
    });

    it("骨架块 aria-hidden（装饰，不念给读屏）且不含文本", () => {
        const wrapper = mountLoading();
        const skeleton = wrapper.findAll(
            '[data-testid="resource-pane-loading"] div[aria-hidden="true"]',
        );
        expect(skeleton).toHaveLength(1);
        expect(skeleton[0]?.text()).toBe("");
    });
});
