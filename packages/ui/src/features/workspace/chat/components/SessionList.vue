<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useSessionStore } from "../../../../stores/session";
import { useChatStore } from "../stores/chat.ts";
import { useAgentStore } from "../../../../stores/agent";
import { useAuthStore } from "../../../../stores/auth";
import { ApiError, api, type DelegationUsageView } from "../../../../composables/api";
import type { Session } from "../../../../types";
import { logger } from "../../../../lib/logger";
import { toast } from "vue-sonner";
import SessionItem from "./SessionItem.vue";
import { standaloneChatPath, workspaceChatPath } from "../../../../lib/routes";
import BaseModal from "../../../../components/shared/BaseModal.vue";

const { t } = useI18n();
const router = useRouter();
const sessionStore = useSessionStore();
const chatStore = useChatStore();
const agentStore = useAgentStore();
const auth = useAuthStore();

/**
 * task-352 / `D-1206`：本组件从「左栏唯一的列表」降级为**一个工作区分组**的会话行渲染器。
 *
 * <p>两种数据来源，判据不同：
 * ① **省略 `sessions`** ⇒ 仍是当前工作区的 live 投影（`sessionStore.sessions`），
 *    时间分组头（今天/昨天/更早）与「点会话即打开」的行为逐字不变；
 * ② **传入 `sessions`** ⇒ 这是别的工作区分组的**懒加载快照**。它只渲染行，不再自己分组
 *    （日期分组属于 live 投影的口径），且**只读**：改名/分叉/删除的写入走的是
 *    `X-Workspace-Id` 里的 tab 上下文，就地改会打到当前工作区 —— 选中则交给上层先切上下文。</p>
 *
 * <p>③ **`standalone`**（task-373 / `D-1228`）⇒ 独立会话分组的快照：没有工作区可切，
 *    选中走 `standaloneChatPath`；写入（改名/分叉/删除）一律关闭 —— CP 的会话写面仍取
 *    `TenantContext` 的 workspace，独立会话的写面要等 CP 侧补，前端不假装能改。</p>
 *
 * <p>空态（分组空 / 整列空 / 搜不到）**不在本组件**：那是分组层的判据，见
 * `WorkspaceSessionGroups.vue`。同一个组件里既渲染行又渲染两种空，正是 `task-349` 的原病。</p>
 */
const props = withDefaults(
    defineProps<{
        /** 传入时渲染这份快照（其它工作区分组）；省略则渲染当前工作区的 live 投影。 */
        sessions?: Session[] | null;
        /** 这份列表属于哪个工作区（判只读、判 tab 上下文切换）。 */
        workspaceId?: string | null;
        /** task-373：独立会话分组（无工作区）——只读快照 + 独立会话路由。 */
        standalone?: boolean;
    }>(),
    { sessions: null, workspaceId: null, standalone: false },
);

const emit = defineEmits<{ "new-session": []; "select-foreign-session": [id: string] }>();
const listSessions = computed<Session[]>(() =>
    props.sessions ? props.sessions : sessionStore.sessions,
);
const isForeignGroup = computed(
    () => Boolean(props.workspaceId) && props.workspaceId !== auth.currentWorkspaceId,
);
/** 别组快照与独立会话都不可就地写：写入走的是 tab 工作区上下文，会打到别处。 */
const canMutate = computed(() => !isForeignGroup.value && !props.standalone);
/** 快照模式没有日期分组的权威口径（那是 store 的 `getTimeGroup`），故只按时序遍历。 */
const timeGroups = computed<Record<string, Session[]>>(() => {
    if (!props.sessions) return sessionStore.groupedSessions;
    const sorted = [...props.sessions].sort((a, b) =>
        (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
    );
    return { foreign: sorted };
});

const pendingDeleteSessionId = ref<string | null>(null);
const deleteLoading = ref(false);
const forkingSessionId = ref<string | null>(null);
const pendingForkKeys = new Map<string, string>();
const pendingDeleteSession = computed(
    () => listSessions.value.find((session) => session.id === pendingDeleteSessionId.value) ?? null,
);

const timeGroupLabels: Record<string, string> = {
    today: "sidebar.today",
    yesterday: "sidebar.yesterday",
    earlier: "sidebar.earlier",
};

function handleSelect(id: string) {
    // 独立会话：没有工作区可切，直接进独立会话页（task-373 / `D-1228`）。
    if (props.standalone) {
        sessionStore.selectSession(id);
        void router.push(standaloneChatPath(id));
        return;
    }
    // 别的工作区分组：选中 = 先切 tab 上下文再进会话（写入必须落在那个工作区）。
    if (isForeignGroup.value) {
        emit("select-foreign-session", id);
        return;
    }
    sessionStore.selectSession(id);
    const session = listSessions.value.find((item) => item.id === id);
    const workspaceId = session?.workspaceId ?? auth.currentWorkspaceId;
    if (workspaceId) router.push(workspaceChatPath(workspaceId, id));
}

function handleRename(id: string, title: string) {
    sessionStore.renameSession(id, title).catch((cause) => {
        const message = cause instanceof ApiError ? cause.message : "Failed to rename session";
        logger.error("Rename session failed", cause);
        toast.error(message);
    });
}

function handleDelete(id: string) {
    pendingDeleteSessionId.value = id;
}

const terminalRunStatuses = new Set(["succeeded", "failed", "partial", "ambiguous", "cancelled"]);

// ---- PLAN-0655 T1.5: delegation tree + read-only budget chips ------------------------------
/** Delegated children grouped under their parent session (children may live in any time group). */
const childrenByParent = computed(() => {
    const map = new Map<string, Session[]>();
    for (const session of listSessions.value) {
        if (session.kind === "SPAWN" && session.spawnedFromSessionId) {
            const children = map.get(session.spawnedFromSessionId) ?? [];
            children.push(session);
            map.set(session.spawnedFromSessionId, children);
        }
    }
    return map;
});

/**
 * One group's render order: a delegated session whose parent is in the SAME group renders as an
 * indented child right after that parent (the mock's 挂树); a child whose parent lives in another
 * group keeps its own row so it can never disappear from the list.
 */
function rowsFor(sessions: Session[]): Array<{ session: Session; child: boolean }> {
    const present = new Set(sessions.map((item) => item.id)),
        childIds = new Set<string>();
    for (const [parentId, children] of childrenByParent.value) {
        if (present.has(parentId)) {
            for (const child of children) childIds.add(child.id);
        }
    }
    const rows: Array<{ session: Session; child: boolean }> = [];
    for (const session of sessions) {
        if (childIds.has(session.id)) continue;
        rows.push({ session, child: false });
        for (const child of childrenByParent.value.get(session.id) ?? []) {
            rows.push({ session: child, child: true });
        }
    }
    return rows;
}

/** Read-only budget chips; fetched once per delegated session, cached per list lifetime. */
const delegationUsageBySession = ref(new Map<string, DelegationUsageView>());
const delegatedSessionIds = computed(() =>
    listSessions.value.filter((session) => session.kind === "SPAWN").map((session) => session.id),
);

watch(
    () => delegatedSessionIds.value.join(","),
    async () => {
        for (const sessionId of delegatedSessionIds.value) {
            if (delegationUsageBySession.value.has(sessionId)) continue;
            try {
                delegationUsageBySession.value.set(sessionId, await api.delegationUsage(sessionId));
            } catch (error) {
                logger.warn("failed to read delegation usage", { sessionId, error });
            }
        }
    },
    { immediate: true },
);

function delegationUsage(sessionId: string): DelegationUsageView | null {
    return delegationUsageBySession.value.get(sessionId) ?? null;
}

async function handleFork(id: string) {
    const session = listSessions.value.find((item) => item.id === id);
    if (!session || sessionStore.currentSessionId !== id || forkingSessionId.value) return;

    forkingSessionId.value = id;
    try {
        let sourceBranchId = chatStore.getSelectedBranchId(id);
        if (
            !sourceBranchId ||
            !chatStore.getSessionBranches(id).some((branch) => branch.branchId === sourceBranchId)
        ) {
            await chatStore.loadSessionBranches(id);
            sourceBranchId = chatStore.getSelectedBranchId(id);
        }
        if (
            !sourceBranchId ||
            !chatStore.getSessionBranches(id).some((branch) => branch.branchId === sourceBranchId)
        ) {
            toast.error(t("sidebar.forkBranchUnavailable"));
            return;
        }

        const visibleRoles = new Map(
            chatStore.getMessages(id).map((message) => [message.id, message.role]),
        );
        const serverPage = await api.getMessages(id, sourceBranchId);
        const serverMessages = Array.isArray(serverPage)
            ? serverPage
            : (serverPage.messages ?? serverPage.items ?? []);
        let anchorMessageId: string | undefined;
        for (let index = serverMessages.length - 1; index >= 0; index -= 1) {
            const message = serverMessages[index]!,
                role = message.role.toLowerCase();
            if (
                visibleRoles.get(message.id) === role &&
                (role === "user" || role === "assistant") &&
                message.runId &&
                terminalRunStatuses.has(message.runStatus ?? "")
            ) {
                anchorMessageId = message.id;
                break;
            }
        }
        if (!anchorMessageId) {
            toast.error(t("sidebar.forkAnchorUnavailable"));
            return;
        }

        const keyScope = `${id}:${sourceBranchId}:${anchorMessageId}`;
        const idempotencyKey = pendingForkKeys.get(keyScope) ?? globalThis.crypto.randomUUID();
        pendingForkKeys.set(keyScope, idempotencyKey);
        const forked = await api.forkSession(
            id,
            { sourceBranchId, anchorMessageId },
            idempotencyKey,
        );

        const refreshedSessions = await sessionStore.loadSessions();
        const child =
            refreshedSessions.find((item) => item.id === forked.id) ??
            (await sessionStore.loadSession(forked.id));
        const workspaceId =
            child.workspaceId ??
            forked.workspaceId ??
            session.workspaceId ??
            auth.currentWorkspaceId;
        if (!workspaceId) throw new Error("Forked Session is missing its Workspace");

        sessionStore.selectSession(child.id);
        await router.push(workspaceChatPath(workspaceId, child.id));
        pendingForkKeys.delete(keyScope);
        toast.success(t("sidebar.forkCreated"));
    } catch (cause) {
        const message =
            cause instanceof ApiError
                ? `${cause.problem.code}: ${cause.problem.detail ?? cause.message}`
                : cause instanceof Error
                  ? cause.message
                  : t("sidebar.forkFailed");
        logger.error("Fork Session failed", cause);
        toast.error(message);
    } finally {
        forkingSessionId.value = null;
    }
}

function closeDeleteWarning() {
    if (!deleteLoading.value) pendingDeleteSessionId.value = null;
}

async function confirmDelete() {
    const session = pendingDeleteSession.value;
    if (!session || deleteLoading.value) return;
    deleteLoading.value = true;
    const id = session.id;
    try {
        await sessionStore.deleteSession(id);
        chatStore.clearSession(id);
        pendingDeleteSessionId.value = null;
    } catch (cause) {
        const message = cause instanceof ApiError ? cause.message : t("sidebar.deleteFailed");
        logger.error("Delete session failed", cause);
        toast.error(message);
    } finally {
        deleteLoading.value = false;
    }
}
</script>

<template>
    <div data-testid="sidebar-session-list" class="flex-1 overflow-y-auto px-2 py-2 space-y-1">
        <div v-for="(sessions, group) in timeGroups" :key="group">
            <div v-if="sessions.length && timeGroupLabels[group]" class="px-1 py-2">
                <span class="text-xs font-medium text-muted-foreground tracking-wider">
                    {{ t(timeGroupLabels[group]) }}
                </span>
            </div>
            <SessionItem
                v-for="row in rowsFor(sessions)"
                :key="row.session.id"
                :session="row.session"
                :is-active="row.session.id === sessionStore.currentSessionId"
                :pending-count="agentStore.pendingApprovalCount(row.session.id)"
                :fork-busy="forkingSessionId === row.session.id"
                :delegated="row.session.kind === 'SPAWN'"
                :delegation-usage="delegationUsage(row.session.id)"
                :indent="row.child"
                :can-mutate="canMutate"
                @select="handleSelect"
                @rename="handleRename"
                @delete="handleDelete"
                @fork="handleFork"
            />
        </div>
    </div>

    <BaseModal :show="pendingDeleteSession !== null" @close="closeDeleteWarning">
        <div
            v-if="pendingDeleteSession"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="session-delete-title"
            aria-describedby="session-delete-child-warning"
            data-testid="session-delete-warning"
        >
            <h2 id="session-delete-title" class="text-base font-semibold">
                {{ t("sidebar.deleteConfirmTitle") }}
            </h2>
            <p class="mt-2 text-sm text-muted-foreground" id="session-delete-child-warning">
                {{ t("sidebar.deleteChildWarning") }}
            </p>
            <p class="mt-3 truncate rounded-md bg-muted/50 px-2 py-1 text-sm text-foreground">
                {{ pendingDeleteSession.title }}
            </p>
            <div class="mt-5 flex justify-end gap-2">
                <button
                    type="button"
                    class="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
                    :disabled="deleteLoading"
                    data-testid="session-delete-cancel"
                    @click="closeDeleteWarning"
                >
                    {{ t("common.cancel") }}
                </button>
                <button
                    type="button"
                    class="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90 disabled:opacity-50"
                    :disabled="deleteLoading"
                    data-testid="session-delete-confirm"
                    @click="confirmDelete"
                >
                    {{ deleteLoading ? t("sidebar.deletePending") : t("sidebar.delete") }}
                </button>
            </div>
        </div>
    </BaseModal>
</template>
