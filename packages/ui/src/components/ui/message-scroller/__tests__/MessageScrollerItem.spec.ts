import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import MessageScrollerItem from "@/components/ui/message-scroller/MessageScrollerItem.vue";
import { MessageScrollerItemContextKey } from "@/composables/messageScrollerVisibility";

/**
 * task-170 E2 的根因面：`contain-intrinsic-size: auto 10rem`（160 px）与真实行高（实测 662 px）
 * 不符 ⇒ 行重测量时浏览器滚动锚定补偿 scrollTop（`502 = 662 − 160`）。
 * 本 spec 只验**绑定契约**（给值就写内联占位、不给就退回类里的 160 px）；
 * 「占位 ≈ 真实后位移真的消失」由浏览器 E2 复测（mock 车道）证明，jsdom 证明不了布局。
 */
function mountItem(props: Record<string, unknown> = {}) {
    return mount(MessageScrollerItem, {
        props,
        slots: { default: '<div data-testid="inner">x</div>' },
        global: {
            provide: { [MessageScrollerItemContextKey as unknown as string]: () => undefined },
        },
    });
}

describe("task-179 MessageScrollerItem 占位高绑定", () => {
    it("给了 intrinsicHeight 就写内联 contain-intrinsic-size（覆盖类里的 auto 10rem）", () => {
        const wrapper = mountItem({ messageId: "m-1", intrinsicHeight: 662 });
        expect(wrapper.attributes("style")).toContain("contain-intrinsic-size: auto 662px");
        // 类保留（未测到的行仍走 160 px 兜底，不是改基准）
        expect(wrapper.classes().join(" ")).toContain("contain-intrinsic-size:auto_10rem");
    });

    it("没给 intrinsicHeight 时不写内联样式（行为与改动前一致）", () => {
        const wrapper = mountItem({ messageId: "m-1" });
        expect(wrapper.attributes("style") ?? "").not.toContain("contain-intrinsic-size");
    });

    it("非法值（0 / 负数 / NaN）不写内联样式 —— 占位塌成 0 比 160 更糟", () => {
        for (const value of [0, -10, Number.NaN]) {
            const wrapper = mountItem({ messageId: "m-1", intrinsicHeight: value });
            expect(wrapper.attributes("style") ?? "").not.toContain("contain-intrinsic-size");
        }
    });

    it("亚像素值取整（662.4 → 662px）", () => {
        const wrapper = mountItem({ messageId: "m-1", intrinsicHeight: 662.4 });
        expect(wrapper.attributes("style")).toContain("auto 662px");
    });

    it("仍保留 data-message-id / data-slot（锚点与测量依赖它们）", () => {
        const wrapper = mountItem({ messageId: "m-9", scrollAnchor: true, intrinsicHeight: 148 });
        expect(wrapper.attributes("data-message-id")).toBe("m-9");
        expect(wrapper.attributes("data-slot")).toBe("message-scroller-item");
        expect(wrapper.attributes("data-scroll-anchor")).toBe("true");
    });
});
