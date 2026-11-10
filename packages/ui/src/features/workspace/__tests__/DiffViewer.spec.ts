import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import DiffViewer from "../components/DiffViewer.vue";
import type * as monacoModule from "monaco-editor";

vi.mock("vue-i18n", () => ({
    useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock(
    "monaco-editor",
    () => ({
        editor: {
            createDiffEditor: vi.fn<typeof monacoModule.editor.createDiffEditor>(),
            createModel: vi.fn<typeof monacoModule.editor.createModel>(),
        },
    }),
    {
        spy: true,
    },
);

describe("DiffViewer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

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

    // PLAN-0753 M1 (F5, task-167): a monaco load failure must be visible, never a silent
    // blank pane (the old catch left an empty editor div that read as "no diff").
    it("F5 fail-fast: a monaco failure surfaces an explicit error state", async () => {
        const monaco = await import("monaco-editor");
        vi.mocked(monaco.editor.createDiffEditor).mockImplementation(() => {
            throw new Error("monaco unavailable");
        });
        const wrapper = mount(DiffViewer, { props: { original: "a", modified: "b" } });
        await flushPromises();
        expect(wrapper.find('[data-testid="workspace-diff-load-failed"]').exists()).toBe(true);
    });

    it("F5: a successful monaco load keeps the editor pane without the error state", async () => {
        const monaco = await import("monaco-editor");
        vi.mocked(monaco.editor.createDiffEditor).mockReturnValue({
            setModel: vi.fn<(diff: unknown) => void>(),
        } as unknown as ReturnType<typeof monaco.editor.createDiffEditor>);
        vi.mocked(monaco.editor.createModel).mockReturnValue({
            dispose: vi.fn<() => void>(),
        } as never);
        const wrapper = mount(DiffViewer, { props: { original: "a", modified: "b" } });
        await flushPromises();
        expect(vi.mocked(monaco.editor.createDiffEditor)).toHaveBeenCalled();
        expect(wrapper.find('[data-testid="workspace-diff-load-failed"]').exists()).toBe(false);
    });
});
