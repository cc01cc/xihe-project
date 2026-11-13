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
import { workspaceChatPath } from "../../../../lib/routes";
import BaseModal from "../../../../components/shared/BaseModal.vue";

const { t } = useI18n();
const router = useRouter();
const sessionStore = useSessionStore();
const chatStore = useChatStore();
const agentStore = useAgentStore();
const auth = useAuthStore();
const pendingDeleteSessionId = ref<string | null>(null);
const deleteLoading = ref(false);
const forkingSessionId = ref<string | null>(null);
const pendingForkKeys = new Map<string, string>();
const pendingDeleteSession = computed(
    () =>
        sessionStore.sessions.find((session) => session.id === pendingDeleteSessionId.value) ??
        null,
);

const timeGroupLabels: Record<string, string> = {
    today: "sidebar.today",
    yesterday: "sidebar.yesterday",
    earlier: "sidebar.earlier",
};

function handleSelect(id: string) {
    sessionStore.selectSession(id);
    const session = sessionStore.sessions.find((item) => item.id === id);
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
    for (const session of sessionStore.sessions) {
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
    sessionStore.sessions
        .filter((session) => session.kind === "SPAWN")
        .map((session) => session.id),
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
    const session = sessionStore.sessions.find((item) => item.id === id);
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
        <div v-for="(sessions, group) in sessionStore.groupedSessions" :key="group">
            <div v-if="sessions.length" class="px-1 py-2">
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
                @select="handleSelect"
                @rename="handleRename"
                @delete="handleDelete"
                @fork="handleFork"
            />
        </div>
        <div
            v-if="sessionStore.filteredSessions.length === 0"
            class="px-3 py-8 text-center text-sm text-muted-foreground"
        >
            {{ t("sidebar.empty") }}
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
