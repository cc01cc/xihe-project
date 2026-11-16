import { describe, it, expect, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { setActivePinia, createPinia } from "pinia";

import FileEditor from "../components/FileEditor.vue";
import FileMetadataPanel from "../components/FileMetadataPanel.vue";
import { i18n } from "../../../i18n";
import { useWorkspaceStore } from "../stores/workspace";
import type { OpenFile } from "../../../types";
import type { OpenOutcome } from "../lib/openOutcome";

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

function openWith(path: string, outcome: OpenOutcome, extra: Partial<OpenFile> = {}) {
    setActivePinia(createPinia());
    const ws = useWorkspaceStore();
    const file: OpenFile = {
        path,
        name: path.split("/").pop() ?? path,
        content: "",
        originalContent: "",
        language: "plaintext",
        modified: false,
        loading: false,
        truncated: false,
        ...extra,
    };
    ws.openFiles.set(path, file);
    ws.activeFilePath = path;
    ws.openOutcomes.set(path, outcome);
    ws.fileTree = [{ name: file.name, path, type: "file", size: outcome.totalBytes ?? undefined }];
    ws.treeLoadedAt = Date.now() - 5000;
    return mount(FileEditor, { global: { plugins: [i18n], stubs: STUBS } });
}

/**
 * task-78 判据③：**不可读三分流必须给出三种不同的呈现**，
 * 而不是同一个 `error` 或同一句「不可读」。
 */
describe("task-78 不可读三分流（FileEditor 呈现）", () => {
    it("① 不可解析 ⇒ 元信息面板 + 「不能按文本解析」，且**不出**错误条", async () => {
        const wrapper = openWith("blob.bin", {
            state: "unparsable",
            reason: null,
            code: null,
            metadataTrusted: true,
            previewBytes: null,
            totalBytes: 8,
        });
        const notice = wrapper.find('[data-testid="workspace-file-meta-notice"]');
        expect(notice.exists(), "① 必须显示元信息面板").toBe(true);
        expect(notice.text()).toBe(i18n.global.t("workspace.fileMetaUnparsable"));
        // **不是失败** ⇒ 不许出现错误条（红条是 ③ 的形态）。
        // 也不许出现 ② 的「超出读取上限」—— ① 和 ② 是两种处境（自查时这里真的错过一次：
        // 把 bodyMissing 写成 `!hasBody(...)`，① 就同时渲染了 ② 的文案）。
        expect(wrapper.text()).not.toContain(i18n.global.t("workspace.fileMetaOversizedEmpty"));
        expect(wrapper.find('[data-testid="workspace-file-body-missing"]').exists()).toBe(false);
        expect(wrapper.text()).not.toContain(
            i18n.global.t("workspace.fileOpOpenFailed", { name: "x" }).slice(0, 4),
        );
    });

    it("② 太大·给了前缀 ⇒ 「已加载前 N，共 M」，且**保留**「加载完整内容」出口", async () => {
        const wrapper = openWith(
            "big.log",
            {
                state: "oversized-partial",
                reason: null,
                code: null,
                metadataTrusted: true,
                previewBytes: 8 * 1024 * 1024,
                totalBytes: 20 * 1024 * 1024,
            },
            { truncated: true, content: "x" },
        );
        const preview = wrapper.find('[data-testid="workspace-file-meta-preview"]');
        expect(preview.exists(), "② partial 必须说出「给了多少」").toBe(true);
        expect(preview.text()).toContain("8.0 MB");
        expect(preview.text()).toContain("20.0 MB");
        // 有东西可看 ⇒ 允许「加载完整内容」。
        expect(wrapper.text()).toContain(i18n.global.t("workspace.editorLoadFull"));
    });

    it("② 太大·一个字都没给 ⇒ 「正文未加载」而不是「已截断」，且**不给**「加载完整内容」", async () => {
        const wrapper = openWith(
            "huge.log",
            {
                state: "oversized-empty",
                reason: null,
                code: null,
                metadataTrusted: true,
                previewBytes: 0,
                totalBytes: 33 * 1024 * 1024,
            },
            { truncated: true },
        );
        // **不许**渲染空编辑器：那看起来像「这是一个空文件」。
        expect(wrapper.find('[data-testid="workspace-file-body-missing"]').exists()).toBe(true);
        // 撒谎的那句话不许出现。
        expect(wrapper.text()).not.toContain(i18n.global.t("workspace.editorTruncated"));
        expect(wrapper.text()).toContain(i18n.global.t("workspace.fileMetaOversizedEmpty"));
        // 一个字都没给 ⇒ 「加载完整内容」是死路（读全文必 OOM）。
        expect(wrapper.text()).not.toContain(i18n.global.t("workspace.editorLoadFull"));
    });

    it("③ 读不到 ⇒ **不出元信息面板**，停在错误态", async () => {
        const wrapper = openWith("secret.txt", {
            state: "unreadable",
            reason: "permission",
            code: "ACCESS_DENIED",
            metadataTrusted: false,
            previewBytes: null,
            totalBytes: null,
        });
        // 元信息不可信 ⇒ 不许显示成「文件在这儿」。
        expect(wrapper.find('[data-testid="workspace-file-meta"]').exists()).toBe(false);
    });

    it("三档的提示文案两两不同（不是同一句）", async () => {
        const unparsable = openWith("b.bin", {
            state: "unparsable",
            reason: null,
            code: null,
            metadataTrusted: true,
            previewBytes: null,
            totalBytes: 1,
        });
        const empty = openWith("h.log", {
            state: "oversized-empty",
            reason: null,
            code: null,
            metadataTrusted: true,
            previewBytes: 0,
            totalBytes: 40 * 1024 * 1024,
        });
        const a = unparsable.find('[data-testid="workspace-file-meta-notice"]').text();
        const b = empty.find('[data-testid="workspace-file-meta-notice"]').text();
        expect(a).not.toBe(b);
    });
});

describe("task-78 元信息面板（零请求 + 诚实标注）", () => {
    it("「文件信息」按钮能把面板打开到**普通文件**上（可见性只由父组件判一次）", async () => {
        const wrapper = openWith("note.txt", {
            state: "content",
            reason: null,
            code: null,
            metadataTrusted: true,
            previewBytes: null,
            totalBytes: 12,
        });
        // content 档默认不展示。
        expect(wrapper.find('[data-testid="workspace-file-meta"]').exists()).toBe(false);
        // 点开必须真的出现 —— 面板内部**不许**再按 outcome 二次门控（那会让按钮空转，
        // `aria-pressed=true` 但一个像素都不渲染；自查时真踩到了）。
        const toggle = wrapper.find('[data-testid="workspace-file-meta-toggle"]');
        expect(toggle.exists()).toBe(true);
        await toggle.trigger("click");
        expect(wrapper.find('[data-testid="workspace-file-meta"]').exists()).toBe(true);
    });

    it("显示七字段中能拿到的，且 is_symlink / created 标「未知」而不是编造", () => {
        const wrapper = openWith("dir/note.txt", {
            state: "unparsable",
            reason: null,
            code: null,
            metadataTrusted: true,
            previewBytes: null,
            totalBytes: 2048,
        });
        const panel = wrapper.findComponent(FileMetadataPanel);
        expect(panel.exists()).toBe(true);
        expect(wrapper.find('[data-testid="workspace-file-meta-name"]').text()).toBe("note.txt");
        expect(wrapper.find('[data-testid="workspace-file-meta-path"]').text()).toBe(
            "dir/note.txt",
        );
        expect(wrapper.find('[data-testid="workspace-file-meta-size"]').text()).toBe("2.0 KB");
        // 树投影里没有这两个字段 ⇒ 必须说「未知」。
        expect(wrapper.find('[data-testid="workspace-file-meta-symlink"]').text()).toBe(
            i18n.global.t("workspace.fileMetaUnknown"),
        );
        expect(wrapper.find('[data-testid="workspace-file-meta-created"]').text()).toBe(
            i18n.global.t("workspace.fileMetaUnknown"),
        );
    });

    it("新鲜度必须显式标（把「不是我读的」与「就是这个值」分开）", () => {
        const wrapper = openWith("a.txt", {
            state: "unparsable",
            reason: null,
            code: null,
            metadataTrusted: true,
            previewBytes: null,
            totalBytes: 1,
        });
        const freshness = wrapper.find('[data-testid="workspace-file-meta-freshness"]');
        expect(freshness.exists()).toBe(true);
        expect(freshness.text()).toContain("秒前");
    });
});
