import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { createI18n } from "vue-i18n";
import ReasoningPart from "../components/parts/ReasoningPart.vue";

/**
 * 2026-11-04 用户裁定（DSH 式过程渲染，Step 1）：推理行不再是 `<details>`，而是与思考/工具
 * 调用/refusal 同一条单行可折叠 chip —— 折叠行有 label + 首行摘要，全文只在展开后渲染。
 */
const i18n = createI18n({
    legacy: false,
    locale: "zh",
    messages: { zh: { chat: { reasoning: "思考" } } },
});

function mountPart(content: string) {
    return mount(ReasoningPart, { props: { content }, global: { plugins: [i18n] } });
}

describe("ReasoningPart", () => {
    it("collapsed by default: label + first-line summary, full body not rendered", () => {
        const wrapper = mountPart("line one\nline two");
        expect(wrapper.text()).toContain("思考");
        expect(wrapper.text()).toContain("line one");
        // 折叠态只渲染摘要行，不渲染全文。
        expect(wrapper.text()).not.toContain("line two");
        expect(
            wrapper.get("[data-testid='process-reasoning']").attributes("data-process-kind"),
        ).toBe("reasoning");
    });

    it("expands on click to render the full content", async () => {
        const wrapper = mountPart("line one\nline two");
        const toggle = wrapper.get('[data-testid="process-row-toggle"]');
        expect(toggle.attributes("aria-expanded")).toBe("false");

        await toggle.trigger("click");
        expect(toggle.attributes("aria-expanded")).toBe("true");
        expect(wrapper.text()).toContain("line two");
    });

    it("renders empty content without crashing", () => {
        const wrapper = mountPart("");
        expect(wrapper.find('[data-testid="process-reasoning"]').exists()).toBe(true);
    });
});
