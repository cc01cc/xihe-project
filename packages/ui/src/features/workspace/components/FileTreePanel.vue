<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
    ChevronRight,
    Folder,
    FolderOpen,
    FolderPlus,
    GitBranch,
    LoaderCircle,
    PanelLeftClose,
    RefreshCw,
    Search,
    Upload,
    X,
} from "@lucide/vue";
import { useWorkspaceStore } from "../stores/workspace";
import type { ApiNestedRepoItem, ApiWorkspaceRoot } from "../../../composables/api";
import { api } from "../../../composables/api";
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

/**
 * PLAN-0641 T2.5 (D41-14): the declare entry is on by default because the V9
 * gate is green (T0.1+T0.2, D41-22). The prop keeps the greying path for
 * regressions instead of deleting it.
 */
const props = withDefaults(defineProps<{ nestedRepoDeclareEnabled?: boolean }>(), {
    nestedRepoDeclareEnabled: true,
});

const { t } = useI18n();
const ws = useWorkspaceStore(),
    auth = useAuthStore();
const searchQuery = ref(""),
    creatingFile = ref(false),
    newFileName = ref("");

/** PLAN-0641 T2.5: discovery list + the inline two-step confirm (B1: prompt then confirm). */
const nestedRepos = ref<ApiNestedRepoItem[]>([]),
    confirmingNestedRepo = ref<string | null>(null),
    declaringNestedRepo = ref(false);
const workspaceName = computed(() => auth.workspace?.name ?? t("sidebar.workspace"));

const undeclaredNestedRepos = computed(() => nestedRepos.value.filter((repo) => !repo.declared));
const canDeclareNestedRepo = computed(
    () => props.nestedRepoDeclareEnabled && auth.canWriteWorkspace,
);

async function loadNestedRepos() {
    const id = auth.currentWorkspaceId;
    if (!id) return;
    try {
        nestedRepos.value = await api.listWorkspaceNestedRepos(id);
    } catch {
        // Discovery is advisory: a failure must not break the file tree.
        nestedRepos.value = [];
    }
}

function nestedRepoTypeLabel(kind: ApiNestedRepoItem["type"]): string {
    return t(`workspace.nestedRepoType_${kind}`);
}

async function confirmDeclareNestedRepo(repo: ApiNestedRepoItem) {
    const id = auth.currentWorkspaceId;
    if (!id || !canDeclareNestedRepo.value || declaringNestedRepo.value) return;
    declaringNestedRepo.value = true;
    try {
        await api.addWorkspaceRoot(id, { path: repo.path });
        confirmingNestedRepo.value = null;
        await Promise.all([ws.refreshTree(), loadNestedRepos()]);
        toast.success(t("workspace.nestedRepoDeclared"));
    } catch (error) {
        const code =
            typeof (error as { problem?: { code?: string } }).problem?.code === "string"
                ? (error as { problem: { code: string } }).problem.code
                : null;
        toast.error(code ?? t("workspace.nestedRepoDeclareFailed"));
    } finally {
        declaringNestedRepo.value = false;
    }
}

onMounted(() => {
    void ws.loadTree();
    void loadNestedRepos();
});

const filteredTree = computed(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return null;
    return { query: q };
});

const isEmpty = computed(() => {
    if (ws.fileTree.length > 0) return false;
    // PLAN-0639 M2: a loaded non-empty secondary root group also enables search.
    if (!ws.isMultiRoot) return true;
    return !Array.from(ws.rootTrees.values()).some((s) => s.loaded && s.nodes.length > 0);
});

/**
 * PLAN-0639 M2 (design §5 candidate ①): one group per declared root of a multi-root
 * workspace; null for single-root workspaces, which keep the pre-M2 flat rendering.
 */
const rootGroups = computed(() => {
    if (!ws.isMultiRoot) return null;
    return ws.workspaceRoots.map((root) => {
        const isPrimary = root.id === ws.primaryRootId;
        return {
            root,
            isPrimary,
            label: rootGroupLabel(root, isPrimary),
            expanded: ws.isRootExpanded(root.id),
            state: ws.rootTreeState(root.id),
        };
    });
});

/** 组头 = alias；主根回退到 hostPath 末段；其余回退到序号（wire 投影无 path，D39-5）。 */
function rootGroupLabel(root: ApiWorkspaceRoot, isPrimary: boolean): string {
    if (root.alias) return root.alias;
    if (isPrimary && ws.primaryRootPath) return pathLastSegment(ws.primaryRootPath);
    return t("workspace.rootGroupFallback", { position: root.position + 1 });
}

/** Windows 路径先归一化再取末段（workspace 硬规则：转正斜杠后处理）。 */
function pathLastSegment(value: string): string {
    const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
    return normalized.split("/").pop() || normalized;
}

/**
 * PLAN-0557/BL-109: the visible line must name the cause; the tooltip is a
 * supplement, never the only carrier. Unknown causes keep the generic copy and
 * show the raw detail underneath instead of hiding it in `title`.
 */
const treeErrorHeadline = computed(() => {
    switch (ws.treeErrorKind) {
        case "runtime":
            return t("workspace.treeLoadFailedRuntime");
        case "tool":
            return t("workspace.treeLoadFailedTool");
        default:
            return t("workspace.treeLoadFailed");
    }
});

const showTreeErrorDetail = computed(() => ws.treeErrorKind === "other");

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

        <!-- PLAN-0641 B11: soft cost hint only, never a hard cap (>16 declared roots). -->
        <p
            v-if="ws.workspaceRoots.length > 16"
            data-testid="roots-cost-hint"
            class="shrink-0 border-b border-border-subtle px-2 py-1 text-[11px] text-muted-foreground"
        >
            {{ t("workspace.nestedReposCostHint") }}
        </p>

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

        <!--
          PLAN-0641 T2.5: undeclared nested git repos discovered by the Runtime probe
          (contract F2). Advisory only — the tree below keeps working when discovery is
          empty or unavailable. B12: the whole workspace-relative path is the label;
          rootId, not the display name, is the key.
        -->
        <div
            v-if="undeclaredNestedRepos.length > 0"
            data-testid="nested-repos-panel"
            class="shrink-0 border-b border-border-subtle px-2 py-1.5"
        >
            <p
                class="flex items-center gap-1 text-[11px] font-semibold text-amber-800 dark:text-amber-200"
            >
                <GitBranch class="size-3" aria-hidden="true" />
                {{ t("workspace.nestedReposTitle") }}
            </p>
            <ul class="mt-1 space-y-1">
                <li
                    v-for="repo in undeclaredNestedRepos"
                    :key="repo.path"
                    class="rounded border border-amber-500/30 bg-amber-500/5 p-1.5 text-xs"
                    data-testid="nested-repo-row"
                >
                    <div class="flex min-w-0 items-center gap-1">
                        <span
                            class="truncate font-mono text-foreground"
                            data-testid="nested-repo-path"
                            :title="repo.path"
                            >{{ repo.path }}</span
                        >
                        <span
                            class="shrink-0 rounded bg-surface-content px-1 text-[10px] text-muted-foreground"
                            data-testid="nested-repo-type"
                            >{{ nestedRepoTypeLabel(repo.type) }}</span
                        >
                    </div>
                    <div
                        v-if="confirmingNestedRepo === repo.path"
                        class="mt-1 flex items-center gap-1"
                        data-testid="nested-repo-confirm"
                    >
                        <span class="min-w-0 flex-1 text-[11px] text-muted-foreground">
                            {{ t("workspace.nestedRepoDeclareConfirm") }}
                        </span>
                        <button
                            type="button"
                            class="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-100"
                            data-testid="nested-repo-declare-confirm"
                            :disabled="declaringNestedRepo"
                            @click="confirmDeclareNestedRepo(repo)"
                        >
                            {{ t("workspace.nestedRepoDeclareYes") }}
                        </button>
                        <button
                            type="button"
                            class="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                            data-testid="nested-repo-declare-cancel"
                            @click="confirmingNestedRepo = null"
                        >
                            {{ t("workspace.nestedRepoDeclareCancel") }}
                        </button>
                    </div>
                    <button
                        v-else
                        type="button"
                        class="mt-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-100"
                        data-testid="nested-repo-declare"
                        :disabled="!canDeclareNestedRepo || declaringNestedRepo"
                        :title="
                            canDeclareNestedRepo
                                ? t('workspace.nestedRepoDeclare')
                                : t('workspace.viewerReadOnly')
                        "
                        @click="confirmingNestedRepo = repo.path"
                    >
                        {{ t("workspace.nestedRepoDeclare") }}
                    </button>
                </li>
            </ul>
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
            <div class="min-w-0 flex-1">
                <p
                    data-testid="workspace-tree-error-message"
                    class="line-clamp-2"
                    :title="ws.treeError"
                >
                    {{ treeErrorHeadline }}
                </p>
                <p
                    v-if="showTreeErrorDetail"
                    data-testid="workspace-tree-error-detail"
                    class="mt-0.5 line-clamp-2 break-words text-[11px] text-muted-foreground"
                >
                    {{ ws.treeError }}
                </p>
            </div>
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
                class="inline-flex items-center gap-1 rounded-md bg-action px-2.5 py-1.5 text-xs font-medium text-action-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

        <!-- PLAN-0639 M2: multi-root workspaces render one group per declared root;
            selecting a root group expands and lazily loads its tree. -->
        <div
            v-else-if="rootGroups"
            data-testid="workspace-tree-grouped"
            class="flex-1 overflow-y-auto py-1 px-1"
        >
            <section
                v-for="group in rootGroups"
                :key="group.root.id"
                data-testid="workspace-tree-root-group"
            >
                <button
                    type="button"
                    data-testid="workspace-tree-root-header"
                    :aria-expanded="group.expanded"
                    class="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :class="group.expanded ? 'bg-accent/40 text-foreground' : ''"
                    @click="ws.toggleRoot(group.root.id)"
                >
                    <ChevronRight
                        class="size-3.5 shrink-0 transition-transform"
                        :class="group.expanded ? 'rotate-90' : ''"
                        aria-hidden="true"
                    />
                    <component
                        :is="group.expanded ? FolderOpen : Folder"
                        class="size-3.5 shrink-0"
                        aria-hidden="true"
                    />
                    <span class="min-w-0 flex-1 truncate" :title="group.label">{{
                        group.label
                    }}</span>
                </button>
                <div v-if="group.expanded" class="pb-1">
                    <div
                        v-if="!group.isPrimary && group.state.loading"
                        data-testid="workspace-tree-root-loading"
                        class="flex items-center justify-center py-2"
                    >
                        <LoaderCircle
                            class="size-4 animate-spin text-muted-foreground"
                            aria-hidden="true"
                        />
                    </div>
                    <div
                        v-else-if="!group.isPrimary && group.state.error"
                        data-testid="workspace-tree-root-error"
                        role="alert"
                        class="mx-1 mt-1 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
                    >
                        <p class="min-w-0 flex-1 line-clamp-2">{{ group.state.error }}</p>
                        <button
                            type="button"
                            data-testid="workspace-tree-root-retry"
                            class="shrink-0 rounded border border-destructive/40 px-1.5 py-0.5 font-medium transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            @click="ws.loadRootTree(group.root.id)"
                        >
                            {{ t("workspace.retry") }}
                        </button>
                    </div>
                    <p
                        v-else-if="
                            !group.isPrimary && group.state.loaded && group.state.nodes.length === 0
                        "
                        data-testid="workspace-tree-root-empty"
                        class="px-2 py-1.5 text-xs text-muted-foreground"
                    >
                        {{ t("workspace.rootEmpty") }}
                    </p>
                    <FileTree
                        v-else-if="group.isPrimary"
                        :search-query="filteredTree?.query ?? ''"
                    />
                    <FileTree
                        v-else
                        :nodes="group.state.nodes"
                        :root-id="group.root.id"
                        :search-query="filteredTree?.query ?? ''"
                    />
                </div>
            </section>
        </div>

        <div v-else class="flex-1 overflow-y-auto py-1 px-1">
            <FileTree :search-query="filteredTree?.query ?? ''" />
        </div>
    </div>
</template>
