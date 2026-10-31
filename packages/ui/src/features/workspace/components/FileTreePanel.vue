<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
    FolderPlus,
    LoaderCircle,
    PanelLeftClose,
    RefreshCw,
    Search,
    Upload,
    X,
} from "@lucide/vue";
import { useWorkspaceStore } from "../stores/workspace";
import { useAuthStore } from "../../../stores/auth";
import { toast } from "vue-sonner";
import FileTree from "./FileTree.vue";

/**
 * PLAN-0582 S3a: the file tree moved inside the workbench's left column, so it
 * owns its own panel head (workspace name + file actions + built-in collapse).
 * That is also where the file-level actions from the old toolbar went (P1-1).
 */
const emit = defineEmits<{
    collapse: [];
}>();

const { t } = useI18n();
const ws = useWorkspaceStore(),
    auth = useAuthStore();
const searchQuery = ref(""),
    creatingFile = ref(false),
    newFileName = ref("");

const workspaceName = computed(() => auth.workspace?.name ?? t("sidebar.workspace"));

onMounted(() => {
    void ws.loadTree();
});

const filteredTree = computed(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return null;
    return { query: q };
});

const isEmpty = computed(() => ws.fileTree.length === 0);

function clearSearch() {
    searchQuery.value = "";
}

function startCreateFile() {
    creatingFile.value = true;
    newFileName.value = "";
}

function cancelCreateFile() {
    creatingFile.value = false;
    newFileName.value = "";
}

async function confirmCreateFile() {
    const name = newFileName.value.trim();
    if (!name) {
        cancelCreateFile();
        return;
    }
    const created = await ws.createFile("", name);
    if (created) cancelCreateFile();
}

function upload() {
    // Same guard the old toolbar upload entry had: VIEWER must not open the dialog.
    if (!auth.canWriteWorkspace) {
        toast.error(t("workspace.viewerReadOnly"));
        return;
    }
    ws.openImportDialog();
}
</script>

<template>
    <div class="flex h-full min-w-0 flex-col">
        <!-- Panel head: workspace identity + file actions + the built-in collapse -->
        <div
            data-testid="workspace-tree-head"
            class="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2"
        >
            <span
                data-testid="workspace-tree-title"
                class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
                :title="workspaceName"
            >
                {{ workspaceName }}
            </span>
            <button
                type="button"
                data-testid="workspace-file-create"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="t('workspace.createFile')"
                :aria-label="t('workspace.createFile')"
                @click="startCreateFile"
            >
                <FolderPlus class="size-3.5" aria-hidden="true" />
            </button>
            <button
                type="button"
                data-testid="workspace-file-upload"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="t('workspace.uploadFile')"
                :aria-label="t('workspace.uploadFile')"
                @click="upload"
            >
                <Upload class="size-3.5" aria-hidden="true" />
            </button>
            <button
                type="button"
                data-testid="workspace-file-refresh"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="t('workspace.refreshFiles')"
                :aria-label="t('workspace.refreshFiles')"
                :class="isEmpty ? 'opacity-60' : ''"
                @click="ws.refreshTree()"
            >
                <RefreshCw class="size-3.5" aria-hidden="true" />
            </button>
            <button
                type="button"
                data-testid="workspace-toolbar-toggle-tree"
                class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :aria-label="t('workspace.collapseFiles')"
                :title="t('workspace.collapseFiles')"
                :aria-pressed="true"
                @click="emit('collapse')"
            >
                <PanelLeftClose class="size-3.5" aria-hidden="true" />
            </button>
        </div>

        <!-- Search stays available, but is disabled while the tree is empty (P1-4). -->
        <div v-if="!isEmpty" class="flex shrink-0 items-center gap-1 px-2 py-1.5">
            <div class="relative flex-1">
                <Search
                    class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                />
                <input
                    v-model="searchQuery"
                    :placeholder="t('workspace.filterFiles')"
                    :aria-label="t('workspace.filterFiles')"
                    data-testid="workspace-tree-filter"
                    class="w-full rounded border bg-surface-content py-1 pl-7 pr-6 text-xs placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                    v-if="searchQuery"
                    class="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent"
                    :title="t('workspace.clearFilter')"
                    :aria-label="t('workspace.clearFilter')"
                    @click="clearSearch"
                >
                    <X class="size-3" aria-hidden="true" />
                </button>
            </div>
        </div>

        <div v-if="creatingFile" class="shrink-0 px-2 pb-1.5">
            <input
                v-model="newFileName"
                data-testid="workspace-create-file-input"
                :placeholder="t('workspace.createFilePlaceholder')"
                :aria-label="t('workspace.createFilePlaceholder')"
                class="w-full rounded border bg-surface-content px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                autofocus
                @keydown.enter.prevent="confirmCreateFile"
                @keydown.esc.prevent="cancelCreateFile"
            />
        </div>

        <div
            v-if="ws.loading"
            data-testid="workspace-tree-loading"
            class="flex flex-1 items-center justify-center"
        >
            <LoaderCircle class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>

        <!-- One inline error style for the screen (P0-4): i18n copy, max 2 lines, retry. -->
        <div
            v-else-if="ws.treeError"
            data-testid="workspace-tree-error"
            role="alert"
            class="mx-2 mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
            <span class="line-clamp-2 min-w-0 flex-1" :title="ws.treeError">
                {{ t("workspace.treeLoadFailed") }}
            </span>
            <button
                type="button"
                data-testid="workspace-tree-retry"
                class="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 font-medium transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="ws.loadTree()"
            >
                {{ t("workspace.retry") }}
            </button>
        </div>

        <div
            v-else-if="isEmpty"
            data-testid="workspace-empty-state"
            class="flex flex-1 flex-col items-center justify-center gap-2 px-3 text-center"
        >
            <FolderPlus class="size-6 text-muted-foreground" aria-hidden="true" />
            <p class="text-sm font-semibold text-foreground">{{ t("workspace.noFiles") }}</p>
            <button
                type="button"
                data-testid="workspace-empty-create-file"
                class="inline-flex items-center gap-1 rounded-md bg-brand px-2.5 py-1.5 text-xs font-medium text-brand-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="startCreateFile"
            >
                {{ t("workspace.createFile") }}
            </button>
            <button
                type="button"
                data-testid="workspace-empty-upload"
                class="rounded-md border border-border-subtle px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="upload"
            >
                {{ t("workspace.uploadFile") }}
            </button>
            <p class="text-[11px] text-muted-foreground">{{ t("workspace.dropHint") }}</p>
        </div>

        <div v-else class="flex-1 overflow-y-auto py-1 px-1">
            <FileTree :search-query="filteredTree?.query ?? ''" />
        </div>
    </div>
</template>
