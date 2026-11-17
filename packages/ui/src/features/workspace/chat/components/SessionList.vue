<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useSessionStore } from "../../../../stores/session";
import { useChatStore } from "../stores/chat.ts";
import { useAgentStore } from "../../../../stores/agent";
import { useAuthStore } from "../../../../stores/auth";
import { api, type DelegationUsageView } from "../../../../composables/api";
import { presentCauseError } from "../../../../lib/errorMessages";
import type { Session } from "../../../../types";
import { logger } from "../../../../lib/logger";
import { toast } from "vue-sonner";
import SessionItem from "./SessionItem.vue";
import { standaloneChatPath, workspaceChatPath } from "../../../../lib/routes";
import BaseModal from "../../../../components/shared/BaseModal.vue";
import { VueDraggable } from "vue-draggable-plus";
import { moveInList, orderIds, type MoveAction } from "../orderPure";

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
        /**
         * task-152 / `D-1221` ④：本列表是否允许**用户排序**（L3 专用）。
         *
         * <p>默认 false ⇒ 渲染与改动前**逐字节一致**（不挂 `VueDraggable`、不加
         * `data-session-id` 包裹层）：L2（工作区组内序）由 `task-153` 另立，
         * 「同构所以顺手做」是最容易越界的一种理由。</p>
         *
         * <p>父层在**搜索态**必须传 false：过滤后的子集不是该分组的全部成员，
         * 拿它写回会把不可见的行从顺序里抹掉（`orderPure.moveInList` 的口径）。</p>
         */
        sortable?: boolean;
        /**
         * 用户顺序（顶层 session id）；由**父层**从 `xihe-layout-global` 读出后传入，
         * 本组件只做投影与交互、不碰持久化（单一 writer 纪律，`D-1222` ⑥）。
         */
        order?: string[];
    }>(),
    { sessions: null, workspaceId: null, standalone: false, sortable: false, order: () => [] },
);

const emit = defineEmits<{
    "new-session": [];
    "select-foreign-session": [id: string];
    /** task-152：拖拽/键盘产生的新顺序（顶层 id）；由父层负责写盘。 */
    reorder: [next: string[]];
}>();
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

/* ------------------------------------------------------------------------- *
 * task-152 / `D-1221` ④：独立会话（L3）的用户顺序
 *
 * 形状三条（卡面判据 3/4/6）：
 * ① 顺序只存**顶层 session id 数组**、在读侧投影 —— `replaceFromServer` 会整体替换
 *    `sessionStore.sessions`，把顺序存在组件里每次刷新/SSE 必丢；
 * ② **未知 id 落最前**（= 最近在上），不追加末尾；
 * ③ **子行随父移动**：拖拽单元是「父行 + 其 delegated 子行」整块，子行不可单独拖，
 *    否则 `rowsFor()` 的「子行紧跟父行」不变量被破。
 *
 * 已知边界（不是遗漏）：跨 tab 不做同步 —— 布局状态今天没有 storage/BroadcastChannel
 * 通道（`services/authChannel.ts` 是登出专用先例，不掺入），切 tab / 刷新重读即可。
 * ------------------------------------------------------------------------- */
/** `aria-live` 的播报文本；先清空再写，重复按同一个键也要重播。 */
const orderAnnouncement = ref("");

/** 当前顺序投影：`sortable` 关或 order 为空时**原样返回**（零开销、零行为差）。 */
function applyOrder(sessions: Session[]): Session[] {
    if (!props.sortable || props.order.length === 0) return sessions;
    const byId = new Map(sessions.map((item) => [item.id, item]));
    return orderIds(
        sessions.map((item) => item.id),
        props.order,
    )
        .map((id) => byId.get(id))
        .filter((item): item is Session => Boolean(item));
}

/**
 * 「父行 + 子行」的拖拽单元。与 `rowsFor()` 同源判据：父行在本组的子会话才收进来，
 * 父在别组的子会话仍保留自己的一行（不许从列表里消失）。
 */
function unitsFor(sessions: Session[]): Array<{ session: Session; children: Session[] }> {
    const projected = applyOrder(sessions);
    const present = new Set(projected.map((item) => item.id));
    const childIds = new Set<string>();
    for (const [parentId, children] of childrenByParent.value) {
        if (!present.has(parentId)) continue;
        for (const child of children) childIds.add(child.id);
    }
    const units: Array<{ session: Session; children: Session[] }> = [];
    for (const session of projected) {
        if (childIds.has(session.id)) continue;
        units.push({ session, children: childrenByParent.value.get(session.id) ?? [] });
    }
    return units;
}

/** 顶层 id（按当前渲染顺序）—— 键盘移动与只认这一层。 */
function topLevelIds(sessions: Session[]): string[] {
    return unitsFor(sessions).map((unit) => unit.session.id);
}

/** 行属性一份，两个渲染分支共用（避免 `SessionItem` 的 props 清单写两遍而漂移）。 */
function rowProps(session: Session, child: boolean) {
    return {
        session,
        isActive: session.id === sessionStore.currentSessionId,
        pendingCount: agentStore.pendingApprovalCount(session.id),
        forkBusy: forkingSessionId.value === session.id,
        delegated: session.kind === "SPAWN",
        delegationUsage: delegationUsage(session.id),
        indent: child,
        canMutate: canMutate.value,
    };
}

function persistOrder(next: string[]): void {
    emit("reorder", next);
}

/** 拖拽落点：`model-value` 就是顶层 id 数组，新顺序原样落盘。 */
function onReorder(next: string[]): void {
    if (!props.sortable) return;
    persistOrder(next);
}

function announcePosition(next: string[], id: string): void {
    const position = next.indexOf(id);
    if (position < 0) return;
    orderAnnouncement.value = "";
    void nextTick(() => {
        orderAnnouncement.value = t("sidebar.orderMoved", { position: position + 1 });
    });
}

/** 键盘等价（既有 a11y 门）：`Alt+↑/↓` ±1、`Alt+Home/End` 到桶首/尾。 */
function onUnitKeydown(event: KeyboardEvent, sessions: Session[]): void {
    if (!props.sortable || !event.altKey) return;
    const action: MoveAction | null =
        event.key === "ArrowUp"
            ? { kind: "delta", delta: -1 }
            : event.key === "ArrowDown"
              ? { kind: "delta", delta: 1 }
              : event.key === "Home"
                ? { kind: "home" }
                : event.key === "End"
                  ? { kind: "end" }
                  : null;
    if (!action) return;
    const unit = (event.target as HTMLElement | null)?.closest?.("[data-session-id]");
    const id = unit?.getAttribute("data-session-id");
    if (!id) return;
    const next = moveInList(props.order, topLevelIds(sessions), id, action);
    if (!next) return; // 已在边界：什么都不做，也不拦默认行为
    event.preventDefault();
    persistOrder(next);
    announcePosition(next, id);
    void nextTick(() => {
        document
            .querySelector<HTMLElement>(`[data-session-id="${id}"] [data-testid="session-item"]`)
            ?.focus();
    });
}

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
        // task-45：`ApiError.message` 就是 CP detail（或 `API error <status>`），直接当文案用
        // 等于英文 detail 直出 ⇒ 走统一入口取可读文案，原文交给下面那行 logger。
        const message = presentCauseError(t, cause, t("sidebar.renameFailed")).copy;
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
        // task-45：toast 面只给可读文案（改前会直出 `CODE: english detail`）。原有 logger 保留。
        const message = presentCauseError(t, cause, t("sidebar.forkFailed")).copy;
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
        const message = presentCauseError(t, cause, t("sidebar.deleteFailed")).copy;
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
            <!--
                task-152（`D-1221` ④）：只有 `sortable`（独立会话 L3）走拖拽分支。
                其余两条路径（当前工作区 live / 别组快照）走 `v-else`，DOM 与改动前
                逐字节一致 —— 判据 1 是用 DOM 比较钉的，不靠自觉。
                一个时间桶一个实例、不跨组共享 ⇒ 跨桶位置在拖拽时**根本不可达**。
            -->
            <VueDraggable
                v-if="sortable"
                :model-value="topLevelIds(sessions)"
                :animation="150"
                tag="div"
                class="contents"
                @update:model-value="onReorder"
                @keydown="onUnitKeydown($event, sessions)"
            >
                <div
                    v-for="unit in unitsFor(sessions)"
                    :key="unit.session.id"
                    :data-session-id="unit.session.id"
                >
                    <SessionItem
                        v-bind="rowProps(unit.session, false)"
                        @select="handleSelect"
                        @rename="handleRename"
                        @delete="handleDelete"
                        @fork="handleFork"
                    />
                    <SessionItem
                        v-for="child in unit.children"
                        :key="child.id"
                        v-bind="rowProps(child, true)"
                        @select="handleSelect"
                        @rename="handleRename"
                        @delete="handleDelete"
                        @fork="handleFork"
                    />
                </div>
            </VueDraggable>
            <template v-else>
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
            </template>
        </div>
        <!-- 键盘移动的播报位（读屏不抢焦点）；先清空再写 ⇒ 重复按同一个键也会重播。 -->
        <p
            v-if="sortable"
            data-testid="sidebar-session-order-status"
            role="status"
            aria-live="polite"
            class="sr-only"
        >
            {{ orderAnnouncement }}
        </p>
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
