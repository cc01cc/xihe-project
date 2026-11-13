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
import { ChevronRight, FolderTree, Loader2, Plus } from "@lucide/vue";
import { api, ApiError, type ApiWorkspace } from "../../../../composables/api";
import type { Session } from "../../../../types";
import { useAuthStore } from "../../../../stores/auth";
import { useSessionStore } from "../../../../stores/session";
import { writeTabWorkspace } from "../../../../lib/workspaceContext";
import { workspaceChatPath } from "../../../../lib/routes";
import { logger } from "../../../../lib/logger";
import SessionList from "./SessionList.vue";

const { t } = useI18n();
const router = useRouter();
const auth = useAuthStore();
const sessionStore = useSessionStore();

const emit = defineEmits<{ "new-session": [workspaceId: string] }>();

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
defineExpose({ expanded, groupRequests, toggleGroup, ensureGroup, isExpanded });

const currentWorkspaceId = computed(() => auth.currentWorkspaceId);
const searchQuery = computed(() => sessionStore.searchQuery.trim().toLowerCase());
const isSearching = computed(() => searchQuery.value.length > 0);
const hasWorkspace = computed(() => workspaces.value.length > 0);

/** 当前工作区排第一 —— `D-1174`：「我在哪」要在列表最上面看得见。 */
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

const hasAnyVisibleSession = computed(() =>
    orderedWorkspaces.value.some((workspace) => visibleSessions(workspace.id).length > 0),
);

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
    void router.push(workspaceChatPath(workspace.id, sessionId));
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
    await loadWorkspaces();
    const first = currentWorkspaceId.value ?? orderedWorkspaces.value[0]?.id ?? null;
    if (!first) return;
    if (!isExpanded(first)) expanded.value = [...expanded.value, first];
    await ensureGroup(first);
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
            v-else-if="!hasWorkspace"
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
                @click="router.push('/workspace')"
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
            <section
                v-for="workspace in orderedWorkspaces"
                :key="workspace.id"
                :data-testid="`sidebar-workspace-group-${workspace.id}`"
                class="mb-1"
            >
                <div class="flex items-center gap-1">
                    <button
                        type="button"
                        :data-testid="`sidebar-workspace-group-toggle-${workspace.id}`"
                        :aria-expanded="isExpanded(workspace.id)"
                        :aria-label="workspaceLabel(workspace)"
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
                        class="shrink-0 rounded-md p-1 text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        @click="emit('new-session', workspace.id)"
                    >
                        <Plus class="size-3.5" aria-hidden="true" />
                    </button>
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
