import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";

vi.mock("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

// PLAN-0753 M1 (F1/F3): the token component delegates highlighting to the shared singleton.
const highlightCodeBlock = vi.fn<[], Promise<string | null>>(async () => null);

vi.mock("@/composables/useShiki", () => ({
    highlightCodeBlock: (...args: unknown[]) => highlightCodeBlock(...(args as [string, string])),
}));

/** Shiki dual-theme shaped output (defaultColor: false → both palettes as CSS custom props). */
const SHIKI_HTML =
    '<pre class="shiki" style="--shiki-light-bg:#ffffff;--shiki-dark-bg:#0d1117">' +
    '<code><span class="line" style="--shiki-light:#24292e;--shiki-dark:#e1e4e8">' +
    "const x = 1</span></code></pre>";

function tokenProps(code: string, lang = "typescript") {
    return { token: { lang, text: code } };
}

describe("CodeBlockToken", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        highlightCodeBlock.mockImplementation(async (code: string) =>
            code === "boom" ? null : SHIKI_HTML,
        );
    });

    it("F3: one path — every state change goes through the shared highlighter", async () => {
        const { default: CodeBlockToken } = await import("../components/tokens/CodeBlockToken.vue");
        const wrapper = mount(CodeBlockToken, { props: tokenProps("const a = 1") });
        await vi.dynamicImportSettled();
        await wrapper.vm.$nextTick();
        expect(highlightCodeBlock).toHaveBeenCalledTimes(1);
        // There is no streaming/final branch to toggle any more: the component has exactly one
        // highlight entry point, so successive token states all re-invoke the same composable.
        await wrapper.setProps({ token: { lang: "typescript", text: "const ab = 12" } });
        await vi.dynamicImportSettled();
        expect(highlightCodeBlock).toHaveBeenCalledTimes(2);
        await wrapper.setProps({ token: { lang: "text", text: "const abc = 123" } });
        await vi.dynamicImportSettled();
        expect(highlightCodeBlock).toHaveBeenCalledTimes(3);
    });

    it("F2: dual-theme CSS variables survive DOMPurify into the rendered pre", async () => {
        const { default: CodeBlockToken } = await import("../components/tokens/CodeBlockToken.vue");
        const wrapper = mount(CodeBlockToken, { props: tokenProps("const a = 1") });
        await vi.dynamicImportSettled();
        await wrapper.vm.$nextTick();
        const pre = wrapper.find("pre.shiki");
        expect(pre.exists()).toBe(true);
        expect(pre.attributes("style")).toContain("--shiki-light-bg");
        const span = wrapper.find("pre.shiki span");
        expect(span.attributes("style")).toContain("--shiki-dark");
    });

    it("falls back to escaped plain text when highlighting fails", async () => {
        const { default: CodeBlockToken } = await import("../components/tokens/CodeBlockToken.vue");
        const wrapper = mount(CodeBlockToken, { props: tokenProps("boom") });
        await vi.dynamicImportSettled();
        await wrapper.vm.$nextTick();
        const code = wrapper.find("code");
        expect(code.text()).toBe("boom");
        expect(wrapper.html()).not.toContain("<script");
    });

    it("a slow in-flight highlight never paints over a newer token state", async () => {
        const { default: CodeBlockToken } = await import("../components/tokens/CodeBlockToken.vue");
        let releaseFirst!: (value: string | null) => void;
        highlightCodeBlock.mockImplementationOnce(
            () =>
                new Promise<string | null>((resolve) => {
                    releaseFirst = resolve;
                }),
        );
        const wrapper = mount(CodeBlockToken, { props: tokenProps("slow version") });
        await wrapper.vm.$nextTick();
        // The second state resolves immediately and must win.
        highlightCodeBlock.mockImplementationOnce(
            async () => '<pre class="shiki"><code><span class="fast-mark">FAST</span></code></pre>',
        );
        await wrapper.setProps({ token: { lang: "typescript", text: "fast version" } });
        await vi.dynamicImportSettled();
        await wrapper.vm.$nextTick();
        expect(wrapper.text()).toContain("FAST");
        // Releasing the stale first response must not repaint the older state.
        releaseFirst(SHIKI_HTML);
        await vi.dynamicImportSettled();
        await wrapper.vm.$nextTick();
        expect(wrapper.text()).toContain("FAST");
        expect(wrapper.text()).not.toContain("slow version");
    });
});
