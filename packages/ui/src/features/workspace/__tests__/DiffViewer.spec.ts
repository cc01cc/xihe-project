import { describe, it, expect, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DiffViewer from "../components/DiffViewer.vue";

vi.mock("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

describe("DiffViewer", () => {
    it("renders diff container div", () => {
        const wrapper = mount(DiffViewer, { props: { original: "hello", modified: "world" } });
        expect(wrapper.find("div").exists()).toBe(true);
    });

    it("accepts language prop", () => {
        const wrapper = mount(DiffViewer, {
            props: { original: "a", modified: "b", language: "typescript" },
        });
        expect(wrapper.props("language")).toBe("typescript");
    });

    it("renders modified content in props", () => {
        const wrapper = mount(DiffViewer, { props: { original: "hello", modified: "world" } });
        expect(wrapper.props("original")).toBe("hello");
        expect(wrapper.props("modified")).toBe("world");
    });

    it("updates when original and modified change", async () => {
        const wrapper = mount(DiffViewer, { props: { original: "a", modified: "b" } });
        await wrapper.setProps({ original: "new a", modified: "new b" });
        expect(wrapper.props("original")).toBe("new a");
        expect(wrapper.props("modified")).toBe("new b");
    });

    // PLAN-0755 M6：@git-diff-view 接入后，F5 语义改为「解析失败可见」——
    // hunks 缺 ---/+++ 头会静默解析成 0 行（POC 实测坑），适配层补头 + 断言非空。
    it("renders the diff table when given a text pair (git-diff-view)", async () => {
        const wrapper = mount(DiffViewer, { props: { original: "a\nb", modified: "a\nc" } });
        await flushPromises();
        expect(wrapper.find('[data-testid="workspace-diff-viewer"]').exists()).toBe(true);
        // @git-diff-view 挂载后渲染 diff 行（jsdom 下结构断言，像素级交浏览器证据）
        expect(wrapper.find(".diff-tailwindcss-wrapper").exists()).toBe(true);
    });

    it("surfaces an explicit error state when diff parsing yields no lines", async () => {
        const wrapper = mount(DiffViewer, {
            props: { original: "same", modified: "same" },
        });
        await flushPromises();
        // 无差异 ⇒ diffLineLength=0 ⇒ 显式错误态（不静默空面板）
        expect(wrapper.find('[data-testid="workspace-diff-error"]').exists()).toBe(true);
    });
});
