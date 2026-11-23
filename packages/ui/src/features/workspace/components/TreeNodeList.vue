<script setup lang="ts">
import { ref, type Component } from "vue";
import { useI18n } from "vue-i18n";
import {
    ChevronRight,
    Database,
    File,
    FileCode2,
    FileJson,
    FileText,
    Folder,
    FolderOpen,
    GitBranch,
    Image,
    Settings2,
    Table2,
    Terminal,
} from "@lucide/vue";
import { isEmptyDirectoryNode, isDotfileName, useWorkspaceStore } from "../stores/workspace";
import type { FileNode } from "../../../types";
import type { ApiNestedRepoItem } from "../../../composables/api";
import TreeItem from "../../../components/ui/tree/TreeItem.vue";
import FileNodeMenu from "./FileNodeMenu.vue";

/**
 * task-939（R76）: the undeclared-nested-repo declaration is a **one-off action on the
 * tree node itself**, not a full-width card list above the tree. The discovery list
 * is fetched by `FileTreePanel` (the panel owns the workspace id + the refresh
 * lifecycle) and handed down here; this component only renders the badge and the
 * inline two-step confirm, and emits the path back up.
 */
const props = withDefaults(
    defineProps<{
        nodes: FileNode[];
        level: number;
        searchQuery?: string;
        /** PLAN-0639 M2: owning declared root of this tree slice (multi-root grouping). */
        rootId?: string;
        /** Unexpired discovery list (`GET …/nested-repos`); only undeclared entries matter. */
        nestedRepos?: ApiNestedRepoItem[];
        /** False greys the inline entry (declare gate closed or a read-only workspace). */
        nestedRepoCanDeclare?: boolean;
        /** A declaration is in flight; every inline entry is disabled meanwhile. */
        nestedRepoDeclaring?: boolean;
    }>(),
    {
        searchQuery: "",
        rootId: undefined,
        nestedRepos: () => [],
        nestedRepoCanDeclare: false,
        nestedRepoDeclaring: false,
    },
);

const emit = defineEmits<{
    /** The two-step confirm was accepted; the panel performs the POST + refresh. */
    "declare-nested-repo": [path: string];
}>();

const { t } = useI18n();

const ws = useWorkspaceStore();
/** task-939: which nested-repo node currently shows its inline confirm step. */
const confirmingNestedRepo = ref<string | null>(null);

function getIcon(node: FileNode, isExpanded: boolean): Component {
    if (node.type === "directory") return isExpanded ? FolderOpen : Folder;
    const ext = node.name.split(".").pop()?.toLowerCase();
    const map: Record<string, Component> = {
        md: FileText,
        pdf: FileText,
        ts: FileCode2,
        tsx: FileCode2,
        js: FileCode2,
        jsx: FileCode2,
        py: FileCode2,
        rs: FileCode2,
        java: FileCode2,
        go: FileCode2,
        vue: FileCode2,
        json: FileJson,
        yaml: FileJson,
        yml: FileJson,
        css: FileCode2,
        html: FileCode2,
        png: Image,
        jpg: Image,
        jpeg: Image,
        gif: Image,
        svg: Image,
        webp: Image,
        toml: Settings2,
        sql: Database,
        sh: Terminal,
        txt: FileText,
        log: FileText,
        csv: Table2,
    };
    return map[ext || ""] || File;
}

/**
 * task-76（裁定 A）：**目录也要能「打开」**。
 *
 * <p>此前这里对目录直接 `return` —— 于是目录既不会被定位、也永远不高亮，而用户原话是
 * 「打开了某个文件**或目录**时…展开到对应的文件和目录，并进行高亮」。现在：
 * 目录 ⇒ `openDirectory`（展开到它自己 + 标记，**不展开子项**）；
 * 文件 ⇒ `openFile`（展开祖先 + 高亮文件）。两者由 store 保证互斥。</p>
 *
 * <p>注意目录的**展开/收起**仍由 reka 的 toggle 负责（本函数不碰 `expandedPaths` 的增删），
 * 只在「定位」这一层补上语义 —— 否则点目录会既 toggle 又 reveal，行为翻倍。</p>
 */
function handleSelect(node: FileNode) {
    if (node.type === "directory") {
        ws.openDirectory(node.path);
        return;
    }
    ws.openFile(node.path, props.rootId);
}

/**
 * task-76 判据：选中态**不能只靠颜色**（`ui-review` 六维 D）。
 *
 * <p>`aria-selected` / `data-selected` 由 reka 的 `TreeItem` 自带（`TreeItem.js:139/144`），
 * 但那条来自 reka 自己的 selection model；这里额外落 `data-active` 表达「**当前打开/定位的**
 * 节点」这一产品语义，两者由 `FileTree.vue` 的 `v-model:selected` 对齐到同一节点。</p>
 *
 * <p>落成 data 属性而不是靠 class 猜（沿用本文件 `:76` 的做法）：断言要能点名到行/节点。</p>
 */
function isActive(node: FileNode): boolean {
    return node.type === "directory"
        ? ws.activeDirPath === node.path
        : ws.activeFilePath === node.path;
}

/**
 * task-519（484 复盘）：D-1234 的两条视觉判据一�must落在**产品路径**上。
 *
 * 判据本体在 store（`isDotfileName` / `isEmptyDirectoryNode`），这里只做渲染映射。
 * 484 当时把它们写在 `FileTreeNode.vue` 上 —— 那个组件自 `abccd7004`（2026-11-03）起
 * 就被本组件取代、产品路径没有任何 import（**task-76 已删除该死文件**）⇒ 视觉判据在产品
 * 上是空的（真页面行既没有
 * `data-dotfile` 也没有 muted class）。挪到这里才算真的生效。
 *
 * 同时落成 data 属性：颜色是渲染产物，断言要能点名到行/节点而不是猜 CSS。
 */
function isDotfile(node: FileNode): boolean {
    return isDotfileName(node.name);
}

function isEmptyDir(node: FileNode): boolean {
    return isEmptyDirectoryNode(node);
}

/**
 * task-939（R76）: the discovery entry that belongs to this node, if any.
 *
 * <p>Match is by the exact workspace-relative path (`repo.path === node.path`) —
 * B12 already establishes that path, not the display name, is the identity. A path
 * whose directory is not rendered (collapsed ancestor) simply shows nothing here;
 * expanding the tree reveals it. Declared repos are filtered out by the panel.</p>
 */
function repoFor(node: FileNode): ApiNestedRepoItem | undefined {
    if (node.type !== "directory") return undefined;
    return props.nestedRepos.find((repo) => repo.path === node.path && !repo.declared);
}

function repoTypeLabel(repo?: ApiNestedRepoItem): string {
    return repo ? t(`workspace.nestedRepoType_${repo.type}`) : "";
}

/**
 * Positive allowlist (PLAN-0641 T4.4): only a real nested repo / linked worktree can
 * become an independent root. Submodule is the user's own nesting declaration, symlink
 * stays classification-only, bare is warn-only in v1.
 */
function isDeclarableRepo(repo?: ApiNestedRepoItem): boolean {
    return repo?.type === "nested" || repo?.type === "gitdir";
}

function declareDisabled(repo?: ApiNestedRepoItem): boolean {
    return !repo || !props.nestedRepoCanDeclare || props.nestedRepoDeclaring;
}

function repoPathFor(node: FileNode): string {
    return repoFor(node)?.path ?? "";
}

/** B1: the first click only opens the inline confirm step; the POST waits for it. */
function startDeclare(repo?: ApiNestedRepoItem): void {
    if (declareDisabled(repo)) return;
    confirmingNestedRepo.value = repo?.path ?? null;
}

function cancelDeclare(): void {
    confirmingNestedRepo.value = null;
}

function confirmDeclare(repo?: ApiNestedRepoItem): void {
    if (!repo || props.nestedRepoDeclaring) return;
    // 保留确认态：失败时用户要能原地重试（B1 的「失败不停在成功路径上」判据）。
    // 成功时面板重新发现、该 repo 从列表消失 ⇒ 整块入口自然不再渲染。
    emit("declare-nested-repo", repo.path);
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function highlightName(name: string, query?: string): string {
    const q = (query ?? "").trim().toLowerCase();
    if (!q) return escapeHtml(name);
    const idx = name.toLowerCase().indexOf(q);
    if (idx < 0) return escapeHtml(name);
    return `${escapeHtml(name.substring(0, idx))}<b class="bg-yellow-200 dark:bg-yellow-800 rounded-sm px-px">${escapeHtml(name.substring(idx, idx + q.length))}</b>${escapeHtml(name.substring(idx + q.length))}`;
}
</script>

<template>
    <ul>
        <li v-for="node in nodes" :key="node.path">
            <TreeItem
                v-slot="{ isExpanded }"
                :value="node"
                :level="level"
                @select="handleSelect(node)"
            >
                <!--
                    task-939（R76）: the row is one flex line — the row button (min-w-0 flex-1)
                    plus the nested-repo affordance. `FileNodeMenu` wraps the **whole row** so
                    right-click keeps working on the badge/entry too (its trigger is `as-child`,
                    so this div is the element that receives the vendor trigger props).
                -->
                <FileNodeMenu :node="node">
                    <div class="flex items-center gap-1">
                        <button
                            class="flex min-w-0 flex-1 items-center gap-1 py-1 text-sm rounded hover:bg-accent/50 transition-colors select-none text-left"
                            :data-dotfile="isDotfile(node) ? 'true' : undefined"
                            :data-empty-dir="isEmptyDir(node) ? 'true' : undefined"
                            :data-active="isActive(node) ? 'true' : undefined"
                            :aria-current="isActive(node) ? 'true' : undefined"
                            :aria-expanded="node.type === 'directory' ? isExpanded : undefined"
                            :class="{
                                'bg-accent text-accent-foreground': isActive(node),
                                'opacity-60': isEmptyDir(node),
                            }"
                            :style="{ paddingLeft: `${level * 16 + 8}px` }"
                        >
                            <!--
                                task-939（R76）: the expander used to be the literal `▼`/`▶`
                                glyph, so the treeitem's accessible name was "▶ src" — screen
                                readers announced a triangle instead of "collapsed". It is now
                                an icon (aria-hidden) plus the `aria-expanded` state on the row
                                button, which is what the a11y tree is supposed to carry.
                            -->
                            <span class="flex w-4 shrink-0 items-center justify-center">
                                <ChevronRight
                                    v-if="node.type === 'directory'"
                                    class="size-3.5 shrink-0 text-muted-foreground transition-transform"
                                    :class="isExpanded ? 'rotate-90' : ''"
                                    aria-hidden="true"
                                />
                            </span>
                            <component
                                :is="getIcon(node, isExpanded)"
                                class="size-3.5 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                            />
                            <span
                                v-if="!searchQuery"
                                class="truncate flex-1 ml-1"
                                :class="{ 'text-muted-foreground': isDotfile(node) }"
                                >{{ node.name }}</span
                            >
                            <span
                                v-else
                                class="truncate flex-1 ml-1"
                                :class="{ 'text-muted-foreground': isDotfile(node) }"
                                v-html="highlightName(node.name, searchQuery)"
                            />
                        </button>
                        <!--
                            task-939（R76）: undeclared nested repo ⇒ one tree-row affordance
                            (badge + inline two-step declare). It never becomes a block above
                            the tree, and a declared repo simply stops carrying this badge.
                        -->
                        <template v-if="repoFor(node)">
                            <span
                                data-testid="nested-repo-type"
                                :title="repoTypeLabel(repoFor(node))"
                                class="shrink-0 items-center rounded bg-amber-500/10 px-1 text-xs text-amber-800 dark:text-amber-200"
                            >
                                <GitBranch class="mr-0.5 inline size-3" aria-hidden="true" />{{
                                    repoTypeLabel(repoFor(node))
                                }}
                            </span>
                            <div
                                v-if="
                                    isDeclarableRepo(repoFor(node)) &&
                                    confirmingNestedRepo === repoPathFor(node)
                                "
                                data-testid="nested-repo-confirm"
                                class="flex shrink-0 items-center gap-1"
                            >
                                <button
                                    type="button"
                                    class="rounded px-1.5 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-100"
                                    data-testid="nested-repo-declare-confirm"
                                    :title="t('workspace.nestedRepoDeclareConfirm')"
                                    :disabled="nestedRepoDeclaring"
                                    @click="confirmDeclare(repoFor(node))"
                                >
                                    {{ t("workspace.nestedRepoDeclareYes") }}
                                </button>
                                <button
                                    type="button"
                                    class="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                                    data-testid="nested-repo-declare-cancel"
                                    @click="cancelDeclare"
                                >
                                    {{ t("workspace.nestedRepoDeclareCancel") }}
                                </button>
                            </div>
                            <button
                                v-else-if="isDeclarableRepo(repoFor(node))"
                                type="button"
                                class="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-100"
                                data-testid="nested-repo-declare"
                                :disabled="declareDisabled(repoFor(node))"
                                :title="
                                    nestedRepoCanDeclare
                                        ? t('workspace.nestedRepoDeclareConfirm')
                                        : t('workspace.viewerReadOnly')
                                "
                                @click="startDeclare(repoFor(node))"
                            >
                                {{ t("workspace.nestedRepoDeclare") }}
                            </button>
                        </template>
                    </div>
                </FileNodeMenu>
                <TreeNodeList
                    v-if="isExpanded && node.children && node.children.length > 0"
                    :nodes="node.children"
                    :level="level + 1"
                    :search-query="searchQuery"
                    :root-id="rootId"
                    :nested-repos="nestedRepos"
                    :nested-repo-can-declare="nestedRepoCanDeclare"
                    :nested-repo-declaring="nestedRepoDeclaring"
                    @declare-nested-repo="(path: string) => emit('declare-nested-repo', path)"
                />
            </TreeItem>
        </li>
    </ul>
</template>
