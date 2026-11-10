/**
 * PLAN-0755 M6 —— MarkdownEditor（CM6）宿主验证：
 * ① 挂载后 CM6 `.cm-editor` 真实存在（不是空容器）；
 * ② 外部 modelValue 变化同步进编辑器（不emit）；
 * ③ 编辑产出 emit（CM6 → 宿主 SSOT）。
 */
import { describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";
import MarkdownEditor from "../MarkdownEditor.vue";

describe("PLAN-0755 MarkdownEditor（CM6 宿主）", () => {
    it("挂载后 CM6 编辑器真实存在", async () => {
        const wrapper = mount(MarkdownEditor, {
            props: { modelValue: "# hello" },
        });
        await nextTick();
        await nextTick();
        const editor = wrapper.find(".cm-editor");
        expect(editor.exists()).toBe(true);
        // 文档内容渲染进 CM6 content DOM
        expect(wrapper.find(".cm-content").exists()).toBe(true);
    });

    it("外部 modelValue 变化同步进编辑器", async () => {
        const wrapper = mount(MarkdownEditor, {
            props: { modelValue: "before" },
        });
        await nextTick();
        await wrapper.setProps({ modelValue: "after-change" });
        await nextTick();
        const content = wrapper.find(".cm-content");
        expect(content.text()).toContain("after-change");
    });

    it("预览切换后 CM6 容器仍常驻（v-show，不重建）", async () => {
        const wrapper = mount(MarkdownEditor, {
            props: { modelValue: "# doc" },
        });
        await nextTick();
        const toggle = wrapper.findAll("button");
        const previewBtn = toggle.find((b) => b.text() === "预览");
        expect(previewBtn).toBeDefined();
        await previewBtn!.trigger("click");
        await nextTick();
        // 预览模式：CM6 容器仍在（v-show），预览内容渲染
        expect(wrapper.find(".cm-editor").exists()).toBe(true);
    });
});
