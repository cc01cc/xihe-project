<script setup lang="ts">
/**
 * task-352 / `D-1206`：左栏二级列表 = **工作区分组 + 会话项**，不是「先选工作区再进会话」。
 *
 * <p>四条结构事实（`D-1206` ②，用户按 DSH 实拍逐项给的）：
 * ① 工作区是列表里的一级分组（可折叠、文件夹图标、可新建）；
 * ② 会话是分组下的二级项；
 * ③ 没有「选择一个工作区」这一页 —— 点会话右侧直接就是会话；
 * ④ 长列表懒加载。</p>
 *
 * <p><b>为什么必须懒加载（硬约束①）：</b>`GET /api/v1/sessions` 是 workspace 作用域的
 * （CP `SessionController#list` 取 `TenantContext`），而 `/workspaces/{id}/sessions` 只有 POST
 * ⇒ 按组取数 = 每组一次带 `X-Workspace-Id` 的请求。DSH 便宜是因为它读本地 manifest，我们是 HTTP，
 * 所以**首屏只拉「当前/最近」那一组**，展开别组时才拉该组（请求账本见 `groupRequests`）。</p>
 *
 * <p><b>两种空态不许合并（承接 `task-349` 的判据，`D-1205` ①）：</b>
 * 「分组展开但该组无会话」(`sidebar-empty-no-session`) 与「一个分组都没有」
 * (`sidebar-empty-no-workspace`) 的下一步动作不同（新建会话 / 新建工作区），
 * 所以各自一个 testid、各自一个出口，且永不写在同一块里。</p>
 */
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import {
    ChevronRight,
    FolderOpen,
    FolderTree,
    Loader2,
    MessageSquare,
    MoreHorizontal,
    Plus,
    Settings2,
    Users,
} from "@lucide/vue";
import { api, ApiError, type ApiWorkspace } from "../../../../composables/api";
import type { Session } from "../../../../types";
import { useAuthStore } from "../../../../stores/auth";
import { useSessionStore } from "../../../../stores/session";
import {
    readStandaloneSessionOrder,
    writeStandaloneSessionOrder,
} from "../../../../composables/useWorkspaceLayout";
import { writeTabWorkspace } from "../../../../lib/workspaceContext";
import { workspaceSessionPath, workspacePath, workspaceSettingsPath } from "../../../../lib/routes";
import { logger } from "../../../../lib/logger";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "../../../../components/ui/dropdown-menu";
import SessionList from "./SessionList.vue";

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const sessionStore = useSessionStore();

/**
 * task-152 / `D-1221` ④：独立会话（L3）的用户顺序。
 *
 * <p>读一次、改一次都走 `xihe-layout-global` 的那两个 accessor（单一 writer 在
 * `useWorkspaceLayout`，本组件不直接碰 localStorage）。**跨 tab 不同步是已知边界**
 * （布局状态没有 storage/BroadcastChannel 通道），切 tab / 刷新重读即可。</p>
 */
const standaloneOrder = ref<string[]>(readStandaloneSessionOrder());

function persistStandaloneOrder(next: string[]): void {
    standaloneOrder.value = next;
    writeStandaloneSessionOrder(next);
}

const emit = defineEmits<{
    "new-session": [workspaceId: string];
    "new-standalone-session": [];
}>();

const workspaces = ref<ApiWorkspace[]>([]);
const listLoading = ref(true);
const listError = ref<string | null>(null);
/** 已展开的分组（workspace id）。首屏只展开「当前/最近」那一组。 */
const expanded = ref<string[]>([]);
const loadingGroups = ref<Record<string, boolean>>({});
const failedGroups = ref<Record<string, string>>({});
/**
 * 请求账本：**判据②③的读数就落在这里**（首屏 N / 展开 +N / 折叠再展开 +0）。
 * 它是只增的数组而不是计数器 —— 出问题时能看出「为谁拉过」，计数只能告诉你「拉过几次」。
 */
const groupRequests = ref<string[]>([]);

const currentWorkspaceId = computed(() => auth.currentWorkspaceId);
const searchQuery = computed(() => sessionStore.searchQuery.trim().toLowerCase());
const isSearching = computed(() => searchQuery.value.length > 0);
const hasWorkspace = computed(() => workspaces.value.length > 0);

/**
 * 当前工作区排第一 —— `D-1174`：「我在哪」要在列表最上面看得见。
 *
 * <p><b>与「独立会话在最上」是两条正交的轴，不要用一条去消解另一条：</b>
 * 本函数只管**工作区组之间**的相对顺序（当前组打头）；独立会话分组是独立项，按模板顺序
 * 排在所有工作区组**之前**（`D-1754` ③）。所以最终顺序 = 独立会话 → 当前工作区 → 其余工作区。
 * 若把 standalone 挪回 `v-for` 之后，`D-1754` ③ 被推翻；若把当前工作区挪出首位，
 * `D-1174` 被推翻 —— 两条各有断言 `WorkspaceSessionGroups.standalone.spec.ts` 同时钉。</p>
 */
const orderedWorkspaces = computed<ApiWorkspace[]>(() => {
    const current = workspaces.value.find((item) => item.id === currentWorkspaceId.value);
    if (!current) return workspaces.value;
    return [current, ...workspaces.value.filter((item) => item.id !== current.id)];
});

function isCurrentGroup(workspaceId: string): boolean {
    return workspaceId === currentWorkspaceId.value;
}

function isExpanded(workspaceId: string): boolean {
    return expanded.value.includes(workspaceId);
}

/** 当前分组用 live 投影（新建/删除立刻可见）；别组用按 workspace 的懒加载缓存。 */
function groupSessions(workspaceId: string): Session[] {
    if (isCurrentGroup(workspaceId)) return sessionStore.sessions;
    return sessionStore.sessionsByWorkspace[workspaceId] ?? [];
}

/** 搜索只过滤「已经拿到」的行；未展开的分组不会被搜索触发拉取（否则首屏又变成 N 次请求）。 */
function visibleSessions(workspaceId: string): Session[] {
    const all = groupSessions(workspaceId);
    if (!isSearching.value) return all;
    return all.filter((session) => session.title.toLowerCase().includes(searchQuery.value));
}

/**
 * task-373 / `D-1228` + `D-1236`：独立会话分组（无工作区）。
 *
 * <p>三条裁定：命名「独立会话」；**为 0 隐藏分组**；**位置在最上**（`D-1754` ③，用户 2026-11-17
 * 裁定「上提」，该条明写作废 `D-1221` ①「位置：列表末尾」；其余三条硬约束继续有效）。它不属于任何
 * 工作区，所以不参与按组懒加载 —— 一个用户只有一份，首屏一次请求就够（要知道有没有，
 * 才能决定渲不渲染）。</p>
 *
 * <p>读失败时**仍然渲染分组**并给重试：静默隐藏会把「读失败」伪装成「你没有独立会话」。</p>
 */
const standaloneExpanded = ref(true);
const standaloneLoading = ref(false);
const standaloneError = ref<string | null>(null);
const standaloneSessions = computed(() => sessionStore.workspacelessSessions);
const visibleStandalone = computed(() => {
    if (!isSearching.value) return standaloneSessions.value;
    return standaloneSessions.value.filter((session) =>
        session.title.toLowerCase().includes(searchQuery.value),
    );
});
const showStandalone = computed(
    () => standaloneSessions.value.length > 0 || standaloneError.value !== null,
);

async function loadStandalone(): Promise<void> {
    standaloneLoading.value = true;
    standaloneError.value = null;
    try {
        await sessionStore.loadWorkspacelessSessions();
    } catch (cause) {
        standaloneError.value =
            cause instanceof ApiError ? cause.message : t("sidebar.standaloneFailed");
        logger.error("Load standalone sessions failed", cause);
    } finally {
        standaloneLoading.value = false;
    }
}

function retryStandalone(): void {
    void sessionStore.loadWorkspacelessSessions(true).then(
        () => {
            standaloneError.value = null;
        },
        (cause: unknown) => {
            standaloneError.value =
                cause instanceof ApiError ? cause.message : t("sidebar.standaloneFailed");
            logger.error("Retry standalone sessions failed", cause);
        },
    );
}

const hasAnyVisibleSession = computed(
    () =>
        orderedWorkspaces.value.some((workspace) => visibleSessions(workspace.id).length > 0) ||
        visibleStandalone.value.length > 0,
);

/**
 * task-172 / `D-1464`：左栏**当前渲染**的会话行总数（Sidebar 的会话区头计数只读这一个值）。
 *
 * <p>纯派生：不取数、不改状态，逐条镜像本模板的分支条件 —— 只有「真的渲染出 `SessionList`
 * 的那几支」才计行，所以：① 顶层四块（loading / error / 无工作区且无独立会话 / 搜索零命中）
 * 一行都不渲染 ⇒ 0；② 独立会话区仅在 `standaloneExpanded` 且非 loading/error 时计
 * `visibleStandalone`；③ 每个工作区分组仅在**已展开**且非 loading/error 时计
 * `visibleSessions(ws)` —— 折叠（包括「展开过、现在折叠」）的行**不算**，否则区头数字
 * 与列表里看得见的行对不上，而这个数字存在的意义就是「可核」。</p>
 */
const renderedSessionCount = computed(() => {
    if (listLoading.value || listError.value) return 0;
    if (!hasWorkspace.value && !showStandalone.value) return 0;
    if (isSearching.value && !hasAnyVisibleSession.value) return 0;
    let total = 0;
    if (
        showStandalone.value &&
        standaloneExpanded.value &&
        !standaloneLoading.value &&
        !standaloneError.value
    )
        total += visibleStandalone.value.length;
    for (const workspace of orderedWorkspaces.value) {
        if (!isExpanded(workspace.id)) continue;
        if (loadingGroups.value[workspace.id] || failedGroups.value[workspace.id]) continue;
        total += visibleSessions(workspace.id).length;
    }
    return total;
});

async function loadWorkspaces(): Promise<void> {
    listLoading.value = true;
    listError.value = null;
    try {
        workspaces.value = await api.listWorkspaces();
    } catch (cause) {
        listError.value = cause instanceof ApiError ? cause.message : t("sidebar.groupsFailed");
        logger.error("Load workspaces for the sidebar groups failed", cause);
    } finally {
        listLoading.value = false;
    }
}

/**
 * 拉某组会话。**命中缓存 ⇒ 0 请求**（「折叠再展开不重拉」的判据落在这个 early return）。
 * 当前组优先用 live 投影：只有在它还是空的时候才补一次 `loadSessions()`。
 */
async function ensureGroup(workspaceId: string): Promise<void> {
    if (failedGroups.value[workspaceId] || loadingGroups.value[workspaceId]) return;
    if (isCurrentGroup(workspaceId)) {
        if (sessionStore.sessions.length > 0) return;
    } else if (workspaceId in sessionStore.sessionsByWorkspace) {
        return;
    }
    loadingGroups.value = { ...loadingGroups.value, [workspaceId]: true };
    groupRequests.value = [...groupRequests.value, workspaceId];
    try {
        if (isCurrentGroup(workspaceId)) await sessionStore.loadSessions();
        else await sessionStore.loadWorkspaceSessions(workspaceId);
    } catch (cause) {
        failedGroups.value = {
            ...failedGroups.value,
            [workspaceId]:
                cause instanceof ApiError ? cause.message : t("sidebar.groupSessionsFailed"),
        };
        logger.error("Load sessions for a workspace group failed", { workspaceId, cause });
    } finally {
        const next = { ...loadingGroups.value };
        delete next[workspaceId];
        loadingGroups.value = next;
    }
}

async function toggleGroup(workspaceId: string): Promise<void> {
    if (isExpanded(workspaceId)) {
        expanded.value = expanded.value.filter((id) => id !== workspaceId);
        return;
    }
    expanded.value = [...expanded.value, workspaceId];
    await ensureGroup(workspaceId);
}

function retryGroup(workspaceId: string): void {
    const next = { ...failedGroups.value };
    delete next[workspaceId];
    failedGroups.value = next;
    void ensureGroup(workspaceId);
}

/** 别组的会话：先切 tab 上下文（写入必须落在那个工作区），再进会话。 */
function openForeignSession(workspace: ApiWorkspace, sessionId: string): void {
    writeTabWorkspace({
        id: workspace.id,
        name: workspace.name,
        workspaceRole: workspace.workspaceRole ?? null,
    });
    void router.push(workspaceSessionPath(workspace.id, sessionId));
}

/** 跨工作区动作：先写 tab 上下文（写入必须落在那个工作区），再跳。 */
function switchTabContext(workspace: ApiWorkspace): void {
    writeTabWorkspace({
        id: workspace.id,
        name: workspace.name,
        workspaceRole: workspace.workspaceRole ?? null,
    });
}

function openWorkspaceSettings(workspace: ApiWorkspace): void {
    switchTabContext(workspace);
    void router.push(workspaceSettingsPath(workspace.id));
}

function openWorkspaceMembers(workspace: ApiWorkspace): void {
    switchTabContext(workspace);
    void router.push(workspacePath(workspace.id) + "/members");
}

function openWorkspaceImport(workspace: ApiWorkspace): void {
    switchTabContext(workspace);
    void router.push({ path: workspacePath(workspace.id), query: { importSource: "1" } });
}

function workspaceLabel(workspace: ApiWorkspace): string {
    return workspace.name || `Workspace ${workspace.id.slice(0, 6)}`;
}

/** 判据⑤：选中的会话所在分组必须展开。切工作区（或从别处跳进来）时补一次展开。 */
watch(
    currentWorkspaceId,
    (workspaceId) => {
        if (!workspaceId) return;
        if (!isExpanded(workspaceId)) expanded.value = [...expanded.value, workspaceId];
        void ensureGroup(workspaceId);
    },
    { immediate: true },
);

onMounted(async () => {
    // 独立会话与工作区列表互不依赖：并行发，谁先回都不挡谁。
    void loadStandalone();
    await loadWorkspaces();
    const first = currentWorkspaceId.value ?? orderedWorkspaces.value[0]?.id ?? null;
    if (!first) return;
    if (!isExpanded(first)) expanded.value = [...expanded.value, first];
    await ensureGroup(first);
});

// expose 放在声明之后：`defineExpose` 的对象字面量是就地求值的，提前引用后面的 const 会撞 TDZ。
defineExpose({
    expanded,
    groupRequests,
    toggleGroup,
    ensureGroup,
    isExpanded,
    standaloneExpanded,
    loadStandalone,
    // task-172 / `D-1464`：左栏会话区头的计数源（纯派生读数，见上面的注释）。
    renderedSessionCount,
});
</script>

<template>
    <div data-testid="sidebar-workspace-groups" class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div
            v-if="listLoading"
            data-testid="sidebar-groups-loading"
            class="flex items-center justify-center gap-2 px-3 py-6 text-sm text-muted-foreground"
        >
            <Loader2 class="size-3.5 animate-spin" aria-hidden="true" />
            {{ t("sidebar.groupsLoading") }}
        </div>

        <div v-else-if="listError" data-testid="sidebar-groups-error" class="px-3 py-6 text-center">
            <p class="text-sm text-sidebar-foreground">{{ t("sidebar.groupsFailed") }}</p>
            <p class="mt-1 break-words text-xs text-muted-foreground">{{ listError }}</p>
            <button
                type="button"
                data-testid="sidebar-groups-retry"
                class="mt-3 rounded-md border border-sidebar-border px-2.5 py-1 text-xs hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="loadWorkspaces"
            >
                {{ t("common.retry") }}
            </button>
        </div>

        <!-- 空态一：一个分组都没有（不是「没选工作区」—— `D-1206` 废掉了那个态）。 -->
        <div
            v-else-if="!hasWorkspace && !showStandalone"
            data-testid="sidebar-empty-no-workspace"
            class="px-3 py-8 text-center"
        >
            <p class="text-sm text-sidebar-foreground">{{ t("sidebar.emptyNoWorkspace.title") }}</p>
            <p class="mt-1 text-xs text-muted-foreground">
                {{ t("sidebar.emptyNoWorkspace.body") }}
            </p>
            <button
                type="button"
                data-testid="sidebar-empty-no-workspace-action"
                class="mt-3 rounded-md border border-sidebar-border px-2.5 py-1 text-xs hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="router.push('/workbench')"
            >
                {{ t("sidebar.emptyNoWorkspace.action") }}
            </button>
        </div>

        <!-- 搜索零命中：第三种形态，别拿「该组暂无会话」冒充它。 -->
        <div
            v-else-if="isSearching && !hasAnyVisibleSession"
            data-testid="sidebar-empty-no-match"
            class="px-3 py-8 text-center"
        >
            <p class="text-sm text-sidebar-foreground">{{ t("sidebar.emptyNoMatch") }}</p>
            <button
                type="button"
                data-testid="sidebar-empty-no-match-action"
                class="mt-3 rounded-md border border-sidebar-border px-2.5 py-1 text-xs hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                @click="sessionStore.searchQuery = ''"
            >
                {{ t("sidebar.clearSearch") }}
            </button>
        </div>

        <template v-else>
            <!-- task-373 / `D-1236`：独立会话**在最上** —— `D-1754` ③（用户 2026-11-17 裁定「上提」，
                 该条明写作废 `D-1221` ①「位置：列表末尾」）。为 0 隐藏；读失败仍渲染 + 重试。 -->
            <section v-if="showStandalone" data-testid="sidebar-standalone-group" class="mb-1">
                <div class="flex items-center gap-1">
                    <button
                        type="button"
                        data-testid="sidebar-standalone-group-toggle"
                        :aria-expanded="standaloneExpanded"
                        :aria-label="t('sidebar.standaloneGroup')"
                        class="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click="standaloneExpanded = !standaloneExpanded"
                    >
                        <ChevronRight
                            class="size-3.5 shrink-0 transition-transform"
                            :class="{ 'rotate-90': standaloneExpanded }"
                            aria-hidden="true"
                        />
                        <MessageSquare class="size-4 shrink-0 opacity-70" aria-hidden="true" />
                        <span class="truncate">{{ t("sidebar.standaloneGroup") }}</span>
                    </button>
                    <button
                        type="button"
                        data-testid="sidebar-standalone-group-new"
                        :aria-label="t('sidebar.newChatStandalone')"
                        :title="t('sidebar.newChatStandalone')"
                        class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click="emit('new-standalone-session')"
                    >
                        <Plus class="size-3.5" aria-hidden="true" />
                    </button>
                </div>

                <div v-if="standaloneExpanded" data-testid="sidebar-standalone-group-body">
                    <div
                        v-if="standaloneLoading"
                        data-testid="sidebar-standalone-loading"
                        class="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground"
                    >
                        <Loader2 class="size-3 animate-spin" aria-hidden="true" />
                        {{ t("sidebar.standaloneLoading") }}
                    </div>
                    <div
                        v-else-if="standaloneError"
                        data-testid="sidebar-standalone-error"
                        class="px-3 py-4 text-center"
                    >
                        <p class="text-xs text-sidebar-foreground">{{ standaloneError }}</p>
                        <button
                            type="button"
                            data-testid="sidebar-standalone-retry"
                            class="mt-2 rounded-md border border-sidebar-border px-2 py-0.5 text-xs hover:bg-sidebar-accent"
                            @click="retryStandalone"
                        >
                            {{ t("common.retry") }}
                        </button>
                    </div>
                    <!--
                        task-152（`D-1221` ④）：独立会话区是**全侧栏唯一**的可拖区域。
                        搜索态传 `!isSearching` ⇒ 过滤后的子集不参与排序，避免把不可见的行
                        从顺序里抹掉（`orderPure.moveInList` 的口径）。
                    -->
                    <SessionList
                        v-else-if="visibleStandalone.length"
                        :sessions="visibleStandalone"
                        standalone
                        :sortable="!isSearching"
                        :order="standaloneOrder"
                        @reorder="persistStandaloneOrder"
                    />
                </div>
            </section>

            <section
                v-for="workspace in orderedWorkspaces"
                :key="workspace.id"
                :data-testid="`sidebar-workspace-group-${workspace.id}`"
                :data-snapshot="isCurrentGroup(workspace.id) ? 'live' : 'lazy'"
                class="mb-1"
            >
                <div class="flex items-center gap-1">
                    <button
                        type="button"
                        :data-testid="`sidebar-workspace-group-toggle-${workspace.id}`"
                        :aria-expanded="isExpanded(workspace.id)"
                        :aria-label="workspaceLabel(workspace)"
                        :title="
                            isCurrentGroup(workspace.id)
                                ? undefined
                                : t('sidebar.groupSnapshotHint')
                        "
                        class="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click="toggleGroup(workspace.id)"
                    >
                        <ChevronRight
                            class="size-3.5 shrink-0 transition-transform"
                            :class="{ 'rotate-90': isExpanded(workspace.id) }"
                            aria-hidden="true"
                        />
                        <FolderTree class="size-4 shrink-0 opacity-70" aria-hidden="true" />
                        <span class="truncate">{{ workspaceLabel(workspace) }}</span>
                    </button>
                    <button
                        type="button"
                        :data-testid="`sidebar-workspace-group-new-${workspace.id}`"
                        :aria-label="t('sidebar.groupNewSession')"
                        :title="t('sidebar.groupNewSession')"
                        class="inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click="emit('new-session', workspace.id)"
                    >
                        <Plus class="size-3.5" aria-hidden="true" />
                    </button>
                    <!--
                        task-89 ③：工作区行也有常驻可见的 ⋯（此前只有「+」= 新建会话）。
                        配置类动作都指向**该工作区自己的**设置页/成员页；跨工作区时先写 tab 上下文，
                        否则写请求会落到当前工作区（与 openForeignSession 同一判据）。
                    -->
                    <DropdownMenu>
                        <DropdownMenuTrigger as-child>
                            <button
                                type="button"
                                :data-testid="`sidebar-workspace-more-${workspace.id}`"
                                :aria-label="t('sidebar.moreActions')"
                                :title="t('sidebar.moreActions')"
                                class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground opacity-70 transition-colors hover:bg-sidebar-accent hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                                <MoreHorizontal class="size-4" aria-hidden="true" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" class="w-56">
                            <DropdownMenuItem
                                :data-testid="`sidebar-workspace-more-settings-${workspace.id}`"
                                @select="openWorkspaceSettings(workspace)"
                            >
                                <Settings2 class="size-4" aria-hidden="true" />
                                {{ t("sidebar.workspaceSettings") }}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                :data-testid="`sidebar-workspace-more-members-${workspace.id}`"
                                @select="openWorkspaceMembers(workspace)"
                            >
                                <Users class="size-4" aria-hidden="true" />
                                {{ t("workspace.membersTitle") }}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                :data-testid="`sidebar-workspace-more-import-${workspace.id}`"
                                @select="openWorkspaceImport(workspace)"
                            >
                                <FolderOpen class="size-4" aria-hidden="true" />
                                {{ t("workspace.importSource") }}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>

                <div
                    v-if="isExpanded(workspace.id)"
                    :data-testid="`sidebar-workspace-group-body-${workspace.id}`"
                >
                    <div
                        v-if="loadingGroups[workspace.id]"
                        data-testid="sidebar-group-loading"
                        class="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground"
                    >
                        <Loader2 class="size-3 animate-spin" aria-hidden="true" />
                        {{ t("sidebar.groupSessionsLoading") }}
                    </div>
                    <div
                        v-else-if="failedGroups[workspace.id]"
                        data-testid="sidebar-group-error"
                        class="px-3 py-4 text-center"
                    >
                        <p class="text-xs text-sidebar-foreground">
                            {{ failedGroups[workspace.id] }}
                        </p>
                        <button
                            type="button"
                            data-testid="sidebar-group-retry"
                            class="mt-2 rounded-md border border-sidebar-border px-2 py-0.5 text-xs hover:bg-sidebar-accent"
                            @click="retryGroup(workspace.id)"
                        >
                            {{ t("common.retry") }}
                        </button>
                    </div>
                    <SessionList
                        v-else-if="visibleSessions(workspace.id).length"
                        :workspace-id="workspace.id"
                        :sessions="
                            isCurrentGroup(workspace.id) ? null : visibleSessions(workspace.id)
                        "
                        @select-foreign-session="openForeignSession(workspace, $event)"
                    />
                    <!-- 空态二：分组展开但该组无会话（与「一个分组都没有」不同块、不同出口）。 -->
                    <div
                        v-else-if="!isSearching"
                        data-testid="sidebar-empty-no-session"
                        class="px-3 py-6 text-center"
                    >
                        <p class="text-sm text-sidebar-foreground">
                            {{ t("sidebar.emptyNoSession.title") }}
                        </p>
                        <p class="mt-1 text-xs text-muted-foreground">
                            {{ t("sidebar.emptyNoSession.body") }}
                        </p>
                        <button
                            type="button"
                            data-testid="sidebar-empty-no-session-action"
                            class="mt-3 rounded-md border border-sidebar-border px-2.5 py-1 text-xs hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            @click="emit('new-session', workspace.id)"
                        >
                            {{ t("sidebar.newChat") }}
                        </button>
                    </div>
                </div>
            </section>
        </template>
    </div>
</template>
