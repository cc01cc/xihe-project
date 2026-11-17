<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
    ChevronRight,
    FileText,
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
// task-59：判据与文案键从 lib 直接取 —— 它们不依赖 store 实例，
// 这样整块替身 store 的单测（nestedRepos.spec.ts 等）也能正常渲染。
import {
    fileOpReasonKey,
    fileOpShowsRawDetail,
    fileOpTitleKey,
    visibleErrorSlot,
} from "../lib/fileOpError";
import type { ApiNestedRepoItem, ApiWorkspaceRoot } from "../../../composables/api";
import { api } from "../../../composables/api";
import { useAuthStore } from "../../../stores/auth";
import { readTabWorkspaceId } from "../../../lib/workspaceContext";
import { toast } from "vue-sonner";
import FileTree from "./FileTree.vue";
import { useWorkspaceGitReadState } from "../composables/useWorkspaceGitReadState";
// task-78：诊断面的 technicalDetail 收进 vendor Collapsible（默认折叠、为空不渲染空壳）。
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "../../../components/ui/collapsible";

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

/**
 * task-36 / RSI 缺口1：树面板自己就有只读仓库状态，不必先打开 dock 的「变更」tab。
 * 只做派生展示，权威数据仍是共享的 git-status GET（与 MCP git_status 同源）。
 */
const gitRead = useWorkspaceGitReadState(
    () => readTabWorkspaceId() ?? auth.currentWorkspaceId ?? null,
    (key) => t(key),
);
const gitEntries = computed(() => gitRead.status.value?.entries.slice(0, 5) ?? []);

/**
 * task-365 E（D-1220 邻域）：**当前打开文件的路径**从 workbench 顶部工具栏搬进本面板头。
 * 判据：文件级状态归文件级容器 —— 工具栏是 workbench 层 chrome，不该描述某个文件。
 *
 * <p>为什么是「目录段截断 + 文件名恒可见」两段，而不是整条面包屑：本面板宽 200–320px
 * （`useWorkspaceLayout` 常量），全段面包屑在深层路径下必然溢出，要么横向滚动要么裁掉文件名 ——
 * 而文件名是这条信息里唯一不可省的部分。**被否决候选**：vendored `Breadcrumb` 全段 + 横向滚动容器
 * （成本 = 自定义滚动条 + 溢出阴影，收益 = 中间段可点，但中间段本来就没有点击行为）。</p>
 *
 * <p>旧实现带 `cursor-pointer` 却**没有点击处理** = 假可点，搬过来时一并去掉：这里只读。</p>
 *
 * <p>无文件时整行不渲染（`v-if`）：`D-1161`（task-312）已裁定「未选择文件」这类空态占位不该存在，
 * 本卡不复活它。</p>
 */
const activeFilePath = computed(() => ws.activeFilePath ?? "");
const activeFileName = computed(() => activeFilePath.value.split("/").pop() ?? "");
const activeFileDir = computed(() => {
    const segments = activeFilePath.value.split("/");
    segments.pop();
    return segments.join("/");
});

const undeclaredNestedRepos = computed(() => nestedRepos.value.filter((repo) => !repo.declared));
const canDeclareNestedRepo = computed(
    () => props.nestedRepoDeclareEnabled && auth.canWriteWorkspace,
);

async function loadNestedRepos() {
    // task-188：同 store 口径 —— 逐 tab 上下文优先，登录态只作回落（`auth.currentWorkspaceId`
    // 在 A→B 切换后会滞后到 `/auth/me` 回来，实测这条请求就带了 A 头）。
    const id = readTabWorkspaceId() ?? auth.currentWorkspaceId;
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

/**
 * PLAN-0641 T4.4 (positive allowlist): only a real nested repo / linked worktree can be
 * declared as an independent root. Submodule is the user's own nesting declaration and
 * is never offered (design §6.3 row 4, B6=(a)); symlink stays classification-only
 * (design:108 "不进入本机制", contract F4); bare is warn-only in v1 (B6=(a), §6.1).
 */
function isDeclarableNestedRepo(repo: ApiNestedRepoItem): boolean {
    return repo.type === "nested" || repo.type === "gitdir";
}

/** PLAN-0641 M2 T3.1: localized declaration failure — never the raw CP detail. */
function nestedRepoDeclareError(code: string | null): string {
    switch (code) {
        case "ROOT_IN_USE":
            return t("workspace.nestedRepoDeclareErrorRootInUse");
        case "ROOT_PATH_CONFLICT":
            return t("workspace.nestedRepoDeclareErrorConflict");
        case "INVALID_ROOT_OVERLAP":
            return t("workspace.nestedRepoDeclareErrorOverlap");
        default:
            return t("workspace.nestedRepoDeclareFailed");
    }
}

async function confirmDeclareNestedRepo(repo: ApiNestedRepoItem) {
    const id = readTabWorkspaceId() ?? auth.currentWorkspaceId;
    if (!id || !canDeclareNestedRepo.value || declaringNestedRepo.value) return;
    declaringNestedRepo.value = true;
    try {
        await api.addWorkspaceRoot(id, { path: repo.path });
        confirmingNestedRepo.value = null;
        // Tree + discovery refresh, and the workspace view so the new root group and
        // its B12 path label appear without a manual reload (T3.1).
        await Promise.all([ws.refreshTree(), loadNestedRepos(), auth.refreshWorkspace()]);
        toast.success(t("workspace.nestedRepoDeclared"));
    } catch (error) {
        const code =
            typeof (error as { problem?: { code?: string } }).problem?.code === "string"
                ? (error as { problem: { code: string } }).problem.code
                : null;
        toast.error(nestedRepoDeclareError(code));
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

/**
 * 组头 = workspace 相对路径（B12：两个同末段名的根必须可区分；rootId 才是键）；
 * 回退 alias；主根回退 hostPath 末段；其余回退序号（wire 投影无 path 时，D39-5）。
 */
function rootGroupLabel(root: ApiWorkspaceRoot, isPrimary: boolean): string {
    if (root.path) return root.path;
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

/**
 * task-59（D-1708 缺陷 B）：**横幅只属于树级故障**。文件级故障（某个文件打不开/存不了）
 * 有独立的行内提示 —— 修前它借用这条横幅，于是「一个文件坏了」被读成「整棵树没了」，
 * 用户去点「重试」而树本来就是好的。
 *
 * 兼容口径：`errorScope` 缺失（旧夹具/旧写入方）按树级渲染，与修前逐字节一致。
 */
const errorSlot = computed(() => visibleErrorSlot(ws.errorScope, ws.treeError, ws.fileOpError));

const showTreeBanner = computed(() => errorSlot.value === "tree");

// 横幅分支不再以 `ws.treeError` 作真值条件（改由 errorSlot 决定）⇒ 模板里取不到窄化后的 string，
// 这里显式给出渲染用的字符串副本。
const treeErrorText = computed(() => ws.treeError ?? "");

const fileOp = computed(() => ws.fileOpError ?? null);

/** 标题：点名是**哪个**对象失败了（文件名 + 动作）。 */
const fileOpTitle = computed(() => {
    const op = fileOp.value;
    if (!op) return "";
    const name = op.path ? op.path.split("/").pop() || op.path : "";
    return t(fileOpTitleKey(op.kind), { name });
});

/** 原因：说清**为什么**失败；未判定的原因才附稳定码（不展示后端英文原文）。 */
const fileOpReason = computed(() => {
    const op = fileOp.value;
    if (!op) return "";
    const copy = t(fileOpReasonKey(op.reason));
    return op.code && fileOpShowsRawDetail(op.reason) ? `${copy}（${op.code}）` : copy;
});

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
            class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2"
        >
            <span
                data-testid="workspace-tree-title"
                class="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
                :title="workspaceName"
            >
                {{ workspaceName }}
            </span>
            <!--
                task-89（触控目标，WCAG 2.2 SC 2.5.8 ≥24×24）：四个头按钮原先是 `p-1` + `size-3.5`
                ⇒ 3.5×2 + 12.25 = **19.25px**。四个按钮互相矩形距 0、圆心距 22.75 < 24，
                而两者都欠尺寸 ⇒ 2.5.8 的 **Spacing 例外不成立** ⇒ 真缺陷（不是"看着小"）。
                补 `min-h-7 min-w-7`：本仓 `--spacing` = 3.5px ⇒ 7 步 = **24.5px** 达标；
                图标仍 `size-3.5`（12.25px）不放大 ⇒ 视觉档位不变（DEV-011:194 同动作同尺寸）。
                头栏是 `h-9`(31.5)，24.5 的按钮装得下，不改栏高。
            -->
            <button
                type="button"
                data-testid="workspace-file-create"
                class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="t('workspace.createFile')"
                :aria-label="t('workspace.createFile')"
                @click="startCreateFile"
            >
                <FolderPlus class="size-3.5" aria-hidden="true" />
            </button>
            <button
                type="button"
                data-testid="workspace-file-upload"
                class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :title="t('workspace.uploadFile')"
                :aria-label="t('workspace.uploadFile')"
                @click="upload"
            >
                <Upload class="size-3.5" aria-hidden="true" />
            </button>
            <button
                type="button"
                data-testid="workspace-file-refresh"
                class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :aria-label="t('workspace.collapseFiles')"
                :title="t('workspace.collapseFiles')"
                :aria-pressed="true"
                @click="emit('collapse')"
            >
                <PanelLeftClose class="size-3.5" aria-hidden="true" />
            </button>
        </div>

        <!-- task-36: read-state probe on the file-tree panel itself (no second state source). -->
        <div
            data-testid="workspace-git-readface"
            class="shrink-0 border-b border-border px-2 py-1.5 text-xs"
        >
            <p data-testid="workspace-git-readface-head-hint" class="text-muted-foreground">
                {{ t("workspace.gitReadfaceTitle") }} · {{ t("workspace.gitReadfaceHeadHint") }}
            </p>
            <p
                v-if="gitRead.loading.value"
                data-testid="workspace-git-readface-loading"
                class="text-muted-foreground"
            >
                {{ t("workspace.diffPendingLoading") }}
            </p>
            <!--
                task-78：本块是**诊断面**（持久在屏的树面板错误条），按 AGENTS.md 错误面契约：
                copy（role="alert"）+ **可见可复制的错误码** + 折叠的 technicalDetail。
                改前只渲染 `copy`，而 copy 的兜底句（errors 域的 unknownCode 键）正是
                "…并提供**错误码**" ⇒ 文案要求用户做一件界面没提供的事。composable 早已给出整份 ErrorPresentation
                （useWorkspaceGitReadState.ts:21），这里只是模板没用 ⇒ 不改数据流。
            -->
            <div
                v-else-if="gitRead.error.value"
                data-testid="workspace-git-readface-error"
                class="space-y-1"
            >
                <p
                    data-testid="workspace-git-readface-error-copy"
                    class="text-destructive"
                    role="alert"
                >
                    {{ gitRead.error.value.copy }}
                </p>
                <p
                    v-if="gitRead.error.value.code"
                    data-testid="workspace-git-readface-error-code"
                    class="text-muted-foreground"
                >
                    {{ t("errors.errorCodeLabel") }}
                    <code
                        class="select-all rounded border bg-muted/40 px-1 py-0.5 font-mono text-[11px] text-foreground"
                        data-testid="workspace-git-readface-error-code-value"
                        >{{ gitRead.error.value.code }}</code
                    >
                </p>
                <Collapsible v-if="gitRead.error.value.technicalDetail">
                    <CollapsibleTrigger as-child>
                        <button
                            type="button"
                            data-testid="workspace-git-readface-error-detail-toggle"
                            class="rounded text-muted-foreground underline underline-offset-2"
                        >
                            {{ t("errors.technicalDetail") }}
                        </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                        <pre
                            data-testid="workspace-git-readface-error-detail-body"
                            class="mt-1 max-h-32 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-all text-muted-foreground"
                            >{{ gitRead.error.value.technicalDetail }}</pre>
                    </CollapsibleContent>
                </Collapsible>
                <button
                    type="button"
                    data-testid="workspace-git-readface-error-retry"
                    class="rounded border px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    @click="gitRead.reload()"
                >
                    {{ t("workspace.retry") }}
                </button>
            </div>
            <p
                v-else-if="gitRead.status.value && !gitRead.status.value.isRepository"
                data-testid="workspace-git-readface-no-repo"
                class="text-muted-foreground"
            >
                {{ t("workspace.gitReadfaceNoRepo") }}
            </p>
            <template v-else-if="gitRead.status.value">
                <p data-testid="workspace-git-readface-count" class="font-medium">
                    {{ gitRead.status.value.entries.length }}
                    {{ t("workspace.diffPendingCountUnit") }}
                </p>
                <ul
                    v-if="gitEntries.length > 0"
                    data-testid="workspace-git-readface-entries"
                    class="mt-0.5 space-y-0.5 font-mono"
                >
                    <li v-for="entry in gitEntries" :key="`${entry.status}:${entry.path}`">
                        {{ entry.status }} {{ entry.path }}
                    </li>
                </ul>
            </template>
        </div>

        <!-- task-365 E：当前文件路径（只读；无文件时整行不渲染）。 -->
        <div
            v-if="activeFilePath"
            data-testid="workspace-tree-active-file"
            class="flex h-7 shrink-0 items-center gap-1 border-b border-border px-2 text-xs text-muted-foreground"
            :title="activeFilePath"
            :aria-label="activeFilePath"
        >
            <FileText class="size-3.5 shrink-0" aria-hidden="true" />
            <span
                v-if="activeFileDir"
                data-testid="workspace-tree-active-file-dir"
                class="min-w-0 truncate"
                >{{ activeFileDir }}/</span
            >
            <span
                data-testid="workspace-tree-active-file-name"
                class="shrink-0 font-medium text-foreground"
                >{{ activeFileName }}</span
            >
        </div>

        <!-- PLAN-0641 B11: soft cost hint only, never a hard cap (>16 declared roots). -->
        <p
            v-if="ws.workspaceRoots.length > 16"
            data-testid="roots-cost-hint"
            class="shrink-0 border-b border-border px-2 py-1 text-xs text-muted-foreground"
        >
            {{ t("workspace.nestedReposCostHint") }}
        </p>

        <!-- task-59（D-1708 缺陷 B）：文件级故障的独立提示位。
            与下面那条树级横幅是**两个位**：这里是「某一个文件/目录的动作失败」，树仍可用，
            所以不阻断、不提供「重试整棵树」，只报文件名 + 原因，并允许关掉。 -->
        <div
            v-if="errorSlot === 'file'"
            data-testid="workspace-file-op-error"
            role="status"
            class="mx-2 mt-2 flex items-start gap-2 rounded-md border border-border bg-muted/60 px-2 py-1.5 text-xs text-foreground"
        >
            <div class="min-w-0 flex-1">
                <p
                    data-testid="workspace-file-op-error-message"
                    class="line-clamp-2 break-words font-medium"
                    :title="fileOpTitle"
                >
                    {{ fileOpTitle }}
                </p>
                <p
                    data-testid="workspace-file-op-error-reason"
                    class="mt-0.5 line-clamp-2 break-words text-muted-foreground"
                >
                    {{ fileOpReason }}
                </p>
            </div>
            <button
                type="button"
                data-testid="workspace-file-op-error-dismiss"
                class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                :aria-label="t('common.close')"
                :title="t('common.close')"
                @click="ws.clearFileOpError()"
            >
                <X class="size-3.5" aria-hidden="true" />
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
                    class="w-full rounded border bg-card py-1 pl-7 pr-6 text-xs placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                class="w-full rounded border bg-card px-2 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
            class="shrink-0 border-b border-border px-2 py-1.5"
        >
            <p
                class="flex items-center gap-1 text-xs font-semibold text-amber-800 dark:text-amber-200"
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
                            class="shrink-0 rounded bg-card px-1 text-xs text-muted-foreground"
                            data-testid="nested-repo-type"
                            >{{ nestedRepoTypeLabel(repo.type) }}</span
                        >
                    </div>
                    <div
                        v-if="confirmingNestedRepo === repo.path"
                        class="mt-1 flex items-center gap-1"
                        data-testid="nested-repo-confirm"
                    >
                        <span class="min-w-0 flex-1 text-xs text-muted-foreground">
                            {{ t("workspace.nestedRepoDeclareConfirm") }}
                        </span>
                        <button
                            type="button"
                            class="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-100"
                            data-testid="nested-repo-declare-confirm"
                            :disabled="declaringNestedRepo"
                            @click="confirmDeclareNestedRepo(repo)"
                        >
                            {{ t("workspace.nestedRepoDeclareYes") }}
                        </button>
                        <button
                            type="button"
                            class="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                            data-testid="nested-repo-declare-cancel"
                            @click="confirmingNestedRepo = null"
                        >
                            {{ t("workspace.nestedRepoDeclareCancel") }}
                        </button>
                    </div>
                    <button
                        v-else-if="isDeclarableNestedRepo(repo)"
                        type="button"
                        class="mt-1 rounded px-1.5 py-0.5 text-xs font-medium text-amber-900 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-100"
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
            v-else-if="showTreeBanner"
            data-testid="workspace-tree-error"
            role="alert"
            class="mx-2 mt-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-background px-2 py-1.5 text-xs text-destructive"
        >
            <div class="min-w-0 flex-1">
                <p
                    data-testid="workspace-tree-error-message"
                    class="line-clamp-2"
                    :title="treeErrorText"
                >
                    {{ treeErrorHeadline }}
                </p>
                <p
                    v-if="showTreeErrorDetail"
                    data-testid="workspace-tree-error-detail"
                    class="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground"
                >
                    {{ treeErrorText }}
                </p>
            </div>
            <button
                type="button"
                data-testid="workspace-tree-retry"
                class="shrink-0 rounded border px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                class="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="startCreateFile"
            >
                {{ t("workspace.createFile") }}
            </button>
            <button
                type="button"
                data-testid="workspace-empty-upload"
                class="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="upload"
            >
                {{ t("workspace.uploadFile") }}
            </button>
            <p class="text-xs text-muted-foreground">{{ t("workspace.dropHint") }}</p>
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
                        class="mx-1 mt-1 flex items-start gap-2 rounded-md border border-destructive/40 bg-background px-2 py-1.5 text-xs text-destructive"
                    >
                        <p class="min-w-0 flex-1 line-clamp-2">{{ group.state.error }}</p>
                        <button
                            type="button"
                            data-testid="workspace-tree-root-retry"
                            class="shrink-0 rounded border px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
