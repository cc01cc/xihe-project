<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DiffView } from "@git-diff-view/vue";
import "@git-diff-view/vue/styles/diff-view.css";
import type { DiffFile } from "@git-diff-view/core";
import { diffFileFromHunks, diffFileFromText, assertDiffNotEmpty } from "@/composables/useDiffFile";

export interface DiffFileMeta {
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    oldPath?: string;
    contentHash?: string;
}

export interface DiffLine {
    type: "context" | "add" | "delete" | "hunk";
    content: string;
    oldLine?: number;
    newLine?: number;
}

export interface DiffHunk {
    header: string;
    lines: DiffLine[];
}

const props = withDefaults(
    defineProps<{
        original?: string;
        modified?: string;
        language?: string;
        files?: DiffFileMeta[];
        hunks?: DiffHunk[];
    }>(),
    {
        original: "",
        modified: "",
        files: undefined,
        hunks: undefined,
    },
);

const { t } = useI18n();

/** 服务端 hunks 形态（PLAN-0753 M1 F5）：有 files/hunks 时走预计算 diff。 */
const isUnifiedMode = computed(() => props.files !== undefined || props.hunks !== undefined);

const statusLabel: Record<DiffFileMeta["status"], string> = {
    added: "A",
    modified: "M",
    deleted: "D",
    renamed: "R",
};

const statusColor: Record<DiffFileMeta["status"], string> = {
    added: "text-emerald-400",
    modified: "text-amber-400",
    deleted: "text-red-400",
    renamed: "text-blue-400",
};

const totalAdded = computed(() =>
    (props.hunks ?? []).reduce((n, h) => n + h.lines.filter((l) => l.type === "add").length, 0),
);
const totalDeleted = computed(() =>
    (props.hunks ?? []).reduce((n, h) => n + h.lines.filter((l) => l.type === "delete").length, 0),
);

/** PLAN-0755 M6：diff 高亮唯一亮点 = hljs（@git-diff-view 内建 lowlight/highlight.js）。 */
const diffFile = ref<DiffFile | null>(null);
const diffError = ref<string | null>(null);

function buildDiffFile(): void {
    diffError.value = null;
    diffFile.value = null;
    try {
        if (isUnifiedMode.value) {
            // 形态 B：服务端 hunks（适配层补 ---/+++ 头 + 行数断言）
            diffFile.value = diffFileFromHunks({
                oldFileName: props.files?.[0]?.oldPath ?? props.files?.[0]?.path,
                newFileName: props.files?.[0]?.path,
                oldContent: props.original,
                newContent: props.modified,
                language: props.language,
                hunks: (props.hunks ?? []).flatMap((h) =>
                    h.lines.map((l) => (l.type === "hunk" ? l.content : "")),
                ),
            });
        } else {
            // 形态 A：本地文本对
            diffFile.value = diffFileFromText({
                oldFileName: "original",
                newFileName: "modified",
                oldContent: props.original,
                newContent: props.modified,
                language: props.language,
            });
        }
        if (diffFile.value) assertDiffNotEmpty(diffFile.value);
    } catch (error) {
        diffError.value = error instanceof Error ? error.message : String(error);
    }
}

watch(() => [props.original, props.modified, props.hunks, props.files], buildDiffFile, {
    immediate: true,
});
</script>

<template>
    <div
        data-testid="workspace-diff-viewer"
        class="h-full w-full border rounded-lg overflow-hidden"
    >
        <!-- 统一头部：增删计数 + 文件数（保留 PLAN-0753 M1 语义） -->
        <div
            class="flex items-center gap-4 px-3 py-2 border-b border-zinc-800 bg-zinc-950 text-zinc-500 text-sm font-mono"
        >
            <span class="text-emerald-400">+{{ totalAdded }}</span>
            <span class="text-red-400">-{{ totalDeleted }}</span>
            <span v-if="files?.length" class="ml-auto"
                >{{ files.length }} file{{ files.length !== 1 ? "s" : "" }}</span
            >
        </div>

        <!-- 文件列表（unified 模式） -->
        <div v-if="files?.length" class="border-b border-zinc-800 bg-zinc-950">
            <div
                v-for="file in files"
                :key="file.path"
                class="flex items-center gap-2 px-3 py-1 hover:bg-zinc-900"
            >
                <span :class="['font-bold w-4', statusColor[file.status]]">{{
                    statusLabel[file.status]
                }}</span>
                <span class="text-zinc-300 truncate">{{ file.path }}</span>
                <span v-if="file.contentHash" class="ml-auto text-zinc-600 text-xs">{{
                    file.contentHash
                }}</span>
            </div>
        </div>

        <div v-if="diffError" data-testid="workspace-diff-error" class="p-4 text-red-400 text-sm">
            {{ t("workspace.diffLoadFailed") }}
        </div>
        <div v-else-if="diffFile" class="h-full overflow-auto">
            <DiffView :diffFile="diffFile" diffViewTheme="light" />
        </div>
        <div v-else class="p-4 text-zinc-600 text-center">No diff data</div>
    </div>
</template>
