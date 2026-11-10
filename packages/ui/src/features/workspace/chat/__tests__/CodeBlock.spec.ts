import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

describe("CodeBlock", () => {
    beforeEach(() => {
        Object.assign(navigator, {
            clipboard: {
                writeText: vi
                    .fn<typeof navigator.clipboard.writeText>()
                    .mockResolvedValue(undefined),
            },
        });
    });

    it("renders code and language label", async () => {
        const { default: CodeBlock } = await import("../components/CodeBlock.vue");
        const wrapper = mount(CodeBlock, { props: { code: "const x = 1", lang: "typescript" } });
        expect(wrapper.text()).toContain("typescript");
        expect(wrapper.text()).toContain("const x = 1");
    });

    it("copy button changes text on click", async () => {
        const { default: CodeBlock } = await import("../components/CodeBlock.vue");
        const wrapper = mount(CodeBlock, { props: { code: "test", lang: "text" } }),
            btn = wrapper.findAll("button")[1];
        expect(btn.text()).toBe("chat.copy");
        await btn.trigger("click");
        expect(btn.text()).toBe("chat.copied");
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith("test");
    });

    it("apply button dispatches custom event", async () => {
        const { default: CodeBlock } = await import("../components/CodeBlock.vue");
        const events: CustomEvent[] = [];
        window.addEventListener("xihe:apply-code", (e) => events.push(e as CustomEvent));
        const wrapper = mount(CodeBlock, { props: { code: "console.log(1)", lang: "javascript" } });
        await wrapper.findAll("button")[0].trigger("click");
        expect(events).toHaveLength(1);
        expect(events[0].detail.code).toBe("console.log(1)");
        expect(events[0].detail.lang).toBe("javascript");
    });

    // PLAN-0753 M1 (F2, task-167): shiki dual-theme output carries both palettes as CSS custom
    // properties (defaultColor: false). If sanitizing ever strips them, the F2 theme following
    // dies silently — pin the wire here at the component boundary.
    it("keeps shiki dual-theme CSS variables through sanitization", async () => {
        const { default: CodeBlock } = await import("../components/CodeBlock.vue");
        const highlightedHtml =
            '<pre class="shiki" style="--shiki-light-bg:#ffffff;--shiki-dark-bg:#0d1117">' +
            '<code><span style="--shiki-light:#24292e;--shiki-dark:#e1e4e8">const x = 1</span></code></pre>';
        const wrapper = mount(CodeBlock, {
            props: { code: "const x = 1", lang: "typescript", highlightedHtml },
        });
        expect(wrapper.find("pre.shiki").attributes("style")).toContain("--shiki-dark-bg");
        expect(wrapper.find("pre.shiki span").attributes("style")).toContain("--shiki-dark");
    });
});
