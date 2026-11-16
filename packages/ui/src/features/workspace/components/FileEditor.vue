<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { FileText } from "@lucide/vue";
import { useWorkspaceStore } from "../stores/workspace";
import { useAuthStore } from "../../../stores/auth";
import type { FileNode, OpenFile } from "../../../types";
import EditorTabBar from "./EditorTabBar.vue";
import MarkdownEditor from "./MarkdownEditor.vue";
import CodeEditor from "./CodeEditor.vue";
import ImagePreview from "./ImagePreview.vue";
import PdfViewer from "../chat/components/PdfViewer.vue";
import DiffViewer from "./DiffViewer.vue";
import UnknownFileNotice from "./UnknownFileNotice.vue";
import FileMetadataPanel from "./FileMetadataPanel.vue";
import DirectoryDetailPanel from "./DirectoryDetailPanel.vue";
import { showsMetadata, type OpenOutcome } from "../lib/openOutcome";

const ws = useWorkspaceStore();
const authStore = useAuthStore();
const canWrite = computed(() => authStore.canWriteWorkspace);
const { t } = useI18n();
const diffMode = ref(false);
/** 「元信息」按钮的显式开关：① / ② 两档自动展示，其余状态由用户点开。 */
const metaPinned = ref(false);

const activeFile = computed<OpenFile | null>(() => ws.activeFile);

/**
 * task-78：**这次打开到底给了什么** —— 三态判据的唯一来源（`lib/openOutcome.ts`）。
 * 组件只消费结论，不重新推导 if 链（复写必然分叉）。
 */
const openOutcome = computed<OpenOutcome | null>(() => {
    const f = activeFile.value;
    return f ? (ws.openOutcomes.get(f.path) ?? null) : null;
});
/** 面板出现的时机：① 不可解析 / ② 太大（两档）。`content` 与 `unreadable` 不出现。 */
const showMeta = computed(() => showsMetadata(openOutcome.value) || metaPinned.value);
/**
 * ② 太大·**一个字都没给**：不许渲染成「空文件」。
 *
 * <p>**必须只判 oversized-empty**（自查修）：一开始我写成 `!hasBody(...)`，而 ① 不可解析
 * 也是「没有正文」，于是 ① 的页面上同时出现了 ② 的「超出读取上限」——**两种处境又被合成一句**，
 * 正是本卡要消灭的形态。① 的正文位另有处理（复用 `UnknownFileNotice` 的「不能预览」卡）。</p>
 */
const bodyMissing = computed(() => openOutcome.value?.state === "oversized-empty");
/** ① 不可解析：正文位显示「不能预览 + 下载/复制路径」，与 ② 的「太大」分开。 */
const bodyUnparsable = computed(() => openOutcome.value?.state === "unparsable");

/**
 * task-78 ①：选中的**目录**节点（读 `ws.fileTree`，零请求）。
 *
 * <p>`openDirectory` 会清 `activeFilePath` ⇒ 目录被选中时 `activeFile` 恰好为 null，
 * 本文件原本的「从文件树选择文件」空态就是目录详情页的落点。</p>
 *
 * <p><b>零请求的前提</b>：该目录**已在树里**。`fetchDirectoryTree` 是全递归的（一次载入全树），
 * 所以只要树加载过，任何已挂载的目录都在；只有「树还没加载完」时才没有节点可查 ——
 * 那时详情页不渲染（退回原空态），而**不是**发一次请求去补。</p>
 */
const activeDirNode = computed<FileNode | null>(() => {
    const dirPath = ws.activeDirPath;
    if (!dirPath) return null;
    const find = (nodes: FileNode[]): FileNode | null => {
        for (const n of nodes) {
            if (n.path === dirPath) return n;
            if (n.children) {
                const hit = find(n.children);
                if (hit) return hit;
            }
        }
        return null;
    };
    return find(ws.fileTree);
});

/** 面板要显示的那一条树节点（读已有数据，零请求）。 */
const metaNode = computed<FileNode | null>(() => {
    const f = activeFile.value;
    if (!f) return null;
    const find = (nodes: FileNode[]): FileNode | null => {
        for (const n of nodes) {
            if (n.path === f.path) return n;
            if (n.children) {
                const hit = find(n.children);
                if (hit) return hit;
            }
        }
        return null;
    };
    return find(ws.fileTree);
});

/**
 * 截断横幅的**准确**措辞（取代三处重复的 `editorTruncated`）。
 *
 * <p>旧文案「内容已截断，仅显示文件的一部分」在 `oversized-empty` 档**是撒谎**：
 * 那档一个字都没给。撒谎的提示比没有提示更坏 —— 用户会以为「我看到了东西，只是不完整」，
 * 于是不去找完整内容（Lead 2026-11-16 抬成判据）。</p>
 */
const truncationNotice = computed(() => {
    const o = openOutcome.value;
    if (!o) return activeFile.value?.truncated ? t("workspace.editorTruncated") : null;
    if (o.state === "oversized-partial") return t("workspace.fileMetaOversizedPartial");
    if (o.state === "oversized-empty") return t("workspace.fileMetaOversizedEmpty");
    return null;
});
/** 只有「给了前 N 字节」才提「加载完整内容」；一个字都没给时那个按钮是死路（读全文必 OOM）。 */
const canLoadFull = computed(
    () => openOutcome.value?.state !== "oversized-empty" && activeFile.value?.truncated,
);
function hasKnownExtension(path: string, extensions: string[]) {
    const name = path.split("/").pop()?.toLowerCase() ?? "";
    return extensions.some((ext) => name.endsWith(`.${ext}`) || name.includes(`.${ext}.`));
}

const isImage = computed(() => {
    const f = activeFile.value;
    if (!f) return false;
    return hasKnownExtension(f.path, ["png", "jpg", "jpeg", "gif", "svg", "webp"]);
});
const isMarkdown = computed(() =>
    activeFile.value ? hasKnownExtension(activeFile.value.path, ["md"]) : false,
);
const isPdf = computed(() =>
    activeFile.value ? hasKnownExtension(activeFile.value.path, ["pdf"]) : false,
);
const isCode = computed(() => {
    const f = activeFile.value;
    if (!f) return false;
    return hasKnownExtension(f.path, [
        "ts",
        "tsx",
        "js",
        "jsx",
        "py",
        "rs",
        "java",
        "go",
        "vue",
        "css",
        "html",
        "json",
        "yaml",
        "yml",
        "sql",
        "xml",
        "sh",
        "bash",
        "toml",
        "c",
        "cpp",
        "h",
        "txt",
        "log",
        "csv",
    ]);
});

function handleContentUpdate(content: string) {
    const f = activeFile.value;
    if (f) ws.updateFileContent(f.path, content);
}

function handleSave() {
    if (!canWrite.value) return;
    const f = activeFile.value;
    if (f) ws.saveFile(f.path);
}

function toggleDiff() {
    diffMode.value = !diffMode.value;
}

function toggleMeta() {
    metaPinned.value = !metaPinned.value;
}

function handlePdfSplit() {
    const f = activeFile.value;
    if (f) ws.splitPdf(f.path);
}

function handleChunkIndexChange(index: number) {
    const f = activeFile.value;
    if (f) {
        f.chunkIndex = index;
    }
}

function handleLoadFullContent() {
    const f = activeFile.value;
    if (f) ws.loadFullContent(f.path);
}
</script>

<template>
    <div class="flex flex-col h-full">
        <EditorTabBar
            :open-files="ws.openFileList"
            :active-path="ws.activeFilePath"
            @select="ws.openFile($event)"
            @close="ws.closeFile($event)"
        />

        <div
            v-if="activeFile?.externalChange"
            data-testid="workspace-file-external-change"
            class="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/40 bg-amber-50 px-3 py-1.5 text-xs text-amber-900"
        >
            <span>{{ t("workspace.externalChange") }}</span>
            <button
                type="button"
                class="rounded border border-amber-700/40 px-2 py-0.5 hover:bg-amber-100"
                @click="ws.reloadOpenFile(activeFile.path)"
            >
                {{ t("workspace.reloadExternalChange") }}
            </button>
        </div>

        <!-- task-78：元信息面板（① 不可解析 / ② 太大两档）。数据取文件树快照，零请求。 -->
        <FileMetadataPanel
            v-if="showMeta"
            :node="metaNode"
            :outcome="openOutcome"
            :snapshot-at="ws.treeLoadedAt"
        />

        <!-- task-78 ①：选中目录时显示目录详情（读树快照，零请求）。 -->
        <DirectoryDetailPanel
            v-if="!activeFile && activeDirNode"
            :node="activeDirNode"
            :path="ws.activeDirPath ?? ''"
            :snapshot-at="ws.treeLoadedAt"
        />

        <div v-else-if="!activeFile" class="flex-1 flex items-center justify-center">
            <div class="text-center">
                <FileText class="mx-auto size-12 text-muted-foreground/30" aria-hidden="true" />
                <p class="mt-2 text-sm text-muted-foreground">
                    {{ t("workspace.editorSelectFile") }}
                </p>
            </div>
        </div>

        <!--
            ② 太大（≥32MiB）：`readFilePreview` 的 intercept 分支返回 content 为空串。
            **不许**把它渲染成空编辑器 —— 那看起来像「这是一个空文件」，而事实是
            「正文没加载」。
        -->
        <div
            v-else-if="bodyMissing"
            data-testid="workspace-file-body-missing"
            class="flex-1 flex items-center justify-center px-6"
        >
            <p class="max-w-sm text-center text-sm text-muted-foreground">
                {{ t("workspace.fileMetaOversizedEmpty") }}
            </p>
        </div>

        <!-- ① 不可解析：正文位给「不能预览」卡（下载 / 复制路径），与 ② 的「太大」分开。 -->
        <div v-else-if="bodyUnparsable" class="flex-1 overflow-auto">
            <UnknownFileNotice :file-name="activeFile.name" :file-path="activeFile.path" />
        </div>

        <div v-else-if="isPdf" class="flex-1 overflow-auto">
            <PdfViewer
                :src="activeFile.content"
                :chunks="activeFile.chunks ?? null"
                :chunk-index="activeFile.chunkIndex ?? 0"
                :file-name="activeFile.name"
                @split="handlePdfSplit"
                @update:chunk-index="handleChunkIndexChange"
            />
        </div>

        <div v-else-if="isImage" class="flex-1 overflow-auto">
            <ImagePreview :content="activeFile.content" :file-name="activeFile.name" />
        </div>

        <div v-else-if="isMarkdown" class="flex-1 overflow-hidden flex flex-col">
            <div class="flex items-center justify-between px-3 py-1 border-b bg-muted/20 shrink-0">
                <span class="text-xs text-muted-foreground">{{ activeFile.path }}</span>
                <div class="flex gap-1">
                    <button
                        data-testid="workspace-file-meta-toggle"
                        class="px-2 py-0.5 text-xs rounded border hover:bg-muted transition-colors"
                        :aria-pressed="showMeta"
                        @click="toggleMeta"
                    >
                        {{ t("workspace.fileMetaTitle") }}
                    </button>
                    <button
                        class="px-2 py-0.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30"
                        :disabled="!activeFile.modified || !canWrite"
                        @click="handleSave"
                    >
                        {{
                            activeFile.modified
                                ? t("workspace.editorSave")
                                : t("workspace.editorSaved")
                        }}
                    </button>
                </div>
            </div>
            <!-- task-78：截断提示按**实际给了多少**说话（三档不许共用一句）。 -->
            <div
                v-if="truncationNotice"
                data-testid="workspace-file-truncation"
                class="flex items-center justify-between px-3 py-1.5 text-xs bg-amber-50 text-amber-900 border-b"
            >
                <span>{{ truncationNotice }}</span>
                <button
                    v-if="canLoadFull"
                    class="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700"
                    @click="handleLoadFullContent"
                >
                    {{ t("workspace.editorLoadFull") }}
                </button>
            </div>
            <div class="flex-1 overflow-hidden">
                <MarkdownEditor
                    :model-value="activeFile.content"
                    :readonly="!canWrite"
                    @update:model-value="handleContentUpdate"
                />
            </div>
        </div>

        <div v-else-if="isCode" class="flex-1 overflow-hidden flex flex-col">
            <div class="flex items-center justify-between px-3 py-1 border-b bg-muted/20 shrink-0">
                <span class="text-xs text-muted-foreground">{{ activeFile.path }}</span>
                <div class="flex gap-1">
                    <button
                        data-testid="workspace-file-meta-toggle"
                        class="px-2 py-0.5 text-xs rounded border hover:bg-muted transition-colors"
                        :aria-pressed="showMeta"
                        @click="toggleMeta"
                    >
                        {{ t("workspace.fileMetaTitle") }}
                    </button>
                    <button
                        v-if="activeFile.modified"
                        class="px-2 py-0.5 text-xs rounded border hover:bg-muted transition-colors"
                        @click="toggleDiff"
                    >
                        {{ diffMode ? t("workspace.editorEdit") : t("workspace.editorDiff") }}
                    </button>
                    <button
                        class="px-2 py-0.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-30"
                        :disabled="!activeFile.modified || !canWrite"
                        @click="handleSave"
                    >
                        {{
                            activeFile.modified
                                ? t("workspace.editorSave")
                                : t("workspace.editorSaved")
                        }}
                    </button>
                </div>
            </div>
            <!-- task-78：截断提示按**实际给了多少**说话（三档不许共用一句）。 -->
            <div
                v-if="truncationNotice"
                data-testid="workspace-file-truncation"
                class="flex items-center justify-between px-3 py-1.5 text-xs bg-amber-50 text-amber-900 border-b"
            >
                <span>{{ truncationNotice }}</span>
                <button
                    v-if="canLoadFull"
                    class="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700"
                    @click="handleLoadFullContent"
                >
                    {{ t("workspace.editorLoadFull") }}
                </button>
            </div>
            <div v-if="diffMode && activeFile" class="flex-1 overflow-hidden">
                <DiffViewer
                    :original="activeFile.originalContent"
                    :modified="activeFile.content"
                    :language="activeFile.language"
                />
            </div>
            <div v-else class="flex-1 overflow-hidden">
                <CodeEditor
                    :model-value="activeFile.content"
                    :language="activeFile.language"
                    :readonly="!canWrite"
                    @update:model-value="handleContentUpdate"
                />
            </div>
        </div>

        <div v-else class="flex-1 overflow-auto flex flex-col">
            <div class="flex items-center justify-between px-3 py-1 border-b bg-muted/20 shrink-0">
                <span class="text-xs text-muted-foreground">{{ activeFile.path }}</span>
                <button
                    data-testid="workspace-file-meta-toggle"
                    class="px-2 py-0.5 text-xs rounded border hover:bg-muted transition-colors"
                    :aria-pressed="showMeta"
                    @click="toggleMeta"
                >
                    {{ t("workspace.fileMetaTitle") }}
                </button>
            </div>
            <!-- task-78：截断提示按**实际给了多少**说话（三档不许共用一句）。 -->
            <div
                v-if="truncationNotice"
                data-testid="workspace-file-truncation"
                class="flex items-center justify-between px-3 py-1.5 text-xs bg-amber-50 text-amber-900 border-b"
            >
                <span>{{ truncationNotice }}</span>
                <button
                    v-if="canLoadFull"
                    class="px-2 py-0.5 rounded bg-amber-600 text-white hover:bg-amber-700"
                    @click="handleLoadFullContent"
                >
                    {{ t("workspace.editorLoadFull") }}
                </button>
            </div>
            <div class="flex-1">
                <UnknownFileNotice :file-name="activeFile.name" :file-path="activeFile.path" />
            </div>
        </div>
    </div>
</template>
