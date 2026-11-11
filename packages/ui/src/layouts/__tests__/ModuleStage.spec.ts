import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ModuleStage from "../../layouts/ModuleStage.vue";

describe("ModuleStage (PLAN-0762 T2.2)", () => {
    it("renders one module inside the stage container", () => {
        const wrapper = mount(ModuleStage, {
            slots: { default: "<div data-testid='slot-child'>module</div>" },
        });
        expect(wrapper.get('[data-testid="module-stage"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="slot-child"]').text()).toBe("module");
        // 舞台的职责只有一条：flex 子项 + min-h-0，让模块拿到剩余高度；不接管模块内部布局。
        const classes = wrapper.get('[data-testid="module-stage"]').classes();
        expect(classes).toContain("flex-1");
        expect(classes).toContain("min-h-0");
    });
});
