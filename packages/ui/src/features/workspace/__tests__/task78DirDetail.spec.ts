import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

import FileEditor from "../components/FileEditor.vue";
import DirectoryDetailPanel from "../components/DirectoryDetailPanel.vue";
import { i18n } from "../../../i18n";
import { useWorkspaceStore } from "../stores/workspace";
import type { FileNode } from "../../../types";

vi.mock("vue-router", () => ({
    createRouter: () => ({
        push: vi.fn<() => void>(),
        replace: vi.fn<() => void>(),
        beforeEach: vi.fn<() => void>(),
        afterEach: vi.fn<() => void>(),
        isReady: () => Promise.resolve(),
        currentRoute: { value: {} },
    }),
    createWebHistory: () => ({}),
    useRoute: () => ({ query: {} }),
    useRouter: () => ({ push: vi.fn<() => void>(), replace: vi.fn<() => void>() }),
}));
vi.mock("monaco-editor", () => ({ editor: { create: vi.fn<() => void>() } }));

const STUBS = {
    EditorTabBar: true,
    CodeEditor: true,
    DiffViewer: true,
    MdEditor: true,
    ImagePreview: true,
    PdfViewer: true,
    UnknownFileNotice: true,
};

const TREE: FileNode[] = [
    {
        name: "docs",
        path: "docs",
        type: "directory",
        children: [
            { name: "a.md", path: "docs/a.md", type: "file", size: 10 },
            { name: "b.md", path: "docs/b.md", type: "file", size: 20 },
            {
                name: "inner",
                path: "docs/inner",
                type: "directory",
                children: [{ name: "c.md", path: "docs/inner/c.md", type: "file", size: 5 }],
            },
        ],
    },
    { name: "readme.md", path: "readme.md", type: "file", size: 3 },
];

function mountWithDir(dirPath: string | null) {
    setActivePinia(createPinia());
    const ws = useWorkspaceStore();
    ws.fileTree = TREE;
    ws.treeLoadedAt = Date.now() - 7000;
    ws.activeFilePath = null;
    ws.activeDirPath = dirPath;
    return mount(FileEditor, { global: { plugins: [i18n], stubs: STUBS } });
}

describe("task-78 ① 目录详情页 v1（读树快照，零请求）", () => {
    it("选中目录 ⇒ 显示详情页，字段取自树节点", () => {
        const wrapper = mountWithDir("docs");
        expect(wrapper.findComponent(DirectoryDetailPanel).exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-dir-detail-name"]').text()).toBe("docs");
        expect(wrapper.find('[data-testid="workspace-dir-detail-path"]').text()).toBe("docs");
        expect(wrapper.find('[data-testid="workspace-dir-detail-type"]').text()).toBe(
            i18n.global.t("workspace.fileMetaDir"),
        );
    });

    it("计数按树内可见子项算，且口径写出来", () => {
        const wrapper = mountWithDir("docs");
        const counts = wrapper.find('[data-testid="workspace-dir-detail-count"]').text();
        // docs 直接子项：a.md / b.md / inner ⇒ 共 3 项（2 文件 + 1 目录）。
        expect(counts).toContain("3");
        expect(counts).toContain("1");
        expect(counts).toContain("2");
        // 口径必须显式：数字与 ls 对不上时用户要知道为什么。
        expect(wrapper.find('[data-testid="workspace-dir-detail-scope"]').text()).toContain(
            "文件树",
        );
    });

    it("空目录显示 0 项而不是当成「未加载」", () => {
        // `fetchDirectoryTree` 是全递归的 ⇒ 目录节点的 children 是权威的：
        // `[]` 真的是空目录。这条钉住「不要把空目录说成还没加载」。
        setActivePinia(createPinia());
        const ws = useWorkspaceStore();
        ws.fileTree = [{ name: "empty", path: "empty", type: "directory", children: [] }];
        ws.treeLoadedAt = Date.now();
        ws.activeFilePath = null;
        ws.activeDirPath = "empty";
        const wrapper = mount(FileEditor, { global: { plugins: [i18n], stubs: STUBS } });
        expect(wrapper.find('[data-testid="workspace-dir-detail-count"]').text()).toContain("0");
    });

    it("目录不显示大小，修改时间标「未知」", () => {
        const wrapper = mountWithDir("docs");
        // 目录大小无意义 ⇒ 不许出现「大小」这一行。
        const panel = wrapper.findComponent(DirectoryDetailPanel);
        expect(panel.text()).not.toContain(i18n.global.t("workspace.fileMetaSize"));
        expect(wrapper.find('[data-testid="workspace-dir-detail-modified"]').text()).toBe(
            i18n.global.t("workspace.fileMetaUnknown"),
        );
    });

    it("新鲜度显式标（把「不是我读的」与「就是这个值」分开）", () => {
        const wrapper = mountWithDir("docs");
        const f = wrapper.find('[data-testid="workspace-dir-detail-freshness"]');
        expect(f.exists()).toBe(true);
        expect(f.text()).toContain("秒前");
    });

    it("选中的目录不在树里 ⇒ 退回原空态，**不发请求去补**", () => {
        // 零请求是有条件的：只有「目录已在树里」才成立。树里没有时不许偷偷去列一次。
        const wrapper = mountWithDir("not-loaded-yet");
        expect(wrapper.find('[data-testid="workspace-dir-detail"]').exists()).toBe(false);
        expect(wrapper.text()).toContain(i18n.global.t("workspace.editorSelectFile"));
    });

    it("没有选中目录时不显示详情页（不误报）", () => {
        const wrapper = mountWithDir(null);
        expect(wrapper.find('[data-testid="workspace-dir-detail"]').exists()).toBe(false);
    });
});
