<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import { useSessionStore } from "../../../stores/session";
import { useAuthStore } from "../../../stores/auth";
import { useChatStore } from "../chat/stores/chat";
import { ApiError, api, type WorkspaceAgentBinding } from "../../../composables/api";
import { useWorkspaceSSE } from "../composables/useWorkspaceSSE";
import { logger } from "../../../lib/logger";
import { toast } from "vue-sonner";
import { FolderTree } from "@lucide/vue";
import { useMediaQuery } from "@vueuse/core";
import WorkspaceWorkbench from "../components/WorkspaceWorkbench.vue";
import WorkspaceCreateDialog from "../components/WorkspaceCreateDialog.vue";
import WorkspaceAgentManagementDialog from "../components/WorkspaceAgentManagementDialog.vue";
import MobileWorkspaceSheet from "../components/MobileWorkspaceSheet.vue";
import MobileChatSheet from "../components/MobileChatSheet.vue";
import MobileChangesSheet from "../components/MobileChangesSheet.vue";
import FileImportDialog from "../components/FileImportDialog.vue";
import WorkspaceSourceImportDialog from "../components/WorkspaceSourceImportDialog.vue";
import ChatPanel from "../chat/components/ChatPanel.vue";
import { workspaceChatPath } from "../../../lib/routes";
import BaseModal from "../../../components/shared/BaseModal.vue";

const route = useRoute(),
    router = useRouter(),
    ws = useWorkspaceStore(),
    sessionStore = useSessionStore();
const auth = useAuthStore(),
    chatStore = useChatStore();
const { t } = useI18n();
const isMobileViewport = useMediaQuery("(max-width: 767px)");

// PLAN-0343: run-terminal usage line in the workspace conversation header.
const usageLineSessionId = computed(() =>
    route.params.workspaceId ? sessionStore.currentSessionId : "",
);
const lastUsage = computed(() =>
    usageLineSessionId.value ? chatStore.getSessionLastUsage(usageLineSessionId.value) : null,
);
const usageInput = computed(() => lastUsage.value?.inputTokens);
const usageOutput = computed(() => lastUsage.value?.outputTokens);
const usageSource = computed(() => lastUsage.value?.source);
const usageCost = computed(() => {
    const usage = lastUsage.value;
    if (!usage) return null;
    if (usage.cost == null) return usage.source === "fallback" ? "—" : "未映射";
    return `$${usage.cost}`;
});
const usageCostTitle = computed(() => {
    const usage = lastUsage.value;
    if (!usage || usage.cost != null) return "";
    return usage.costNote ?? "no pricing entry";
});

const routeWorkspaceId = computed(() => {
    const value = route.params.workspaceId as string | undefined;
    return value && value !== "new" ? value : "";
});

const showCreateDialog = ref(false),
    showAgentManagementDialog = ref(false);
const showSourceImportDialog = ref(false),
    showMobileFiles = ref(false),
    showMobileChanges = ref(false),
    mobileAuxTab = ref<"monitor" | "changes">("monitor");
const showAgentSelection = ref(false),
    workspaceAgents = ref<WorkspaceAgentBinding[]>([]);
const selectedAgentPrincipalId = ref(""),
    creatingAgentSession = ref(false);

// ── PLAN-0582 S2: the workbench owns the workspace layout ───────────────────────────────
// The file tree and the right dock (code / changes / monitor) moved into
// `WorkspaceWorkbench`; this page is now data assembly + dialogs + the routed
// center content. Dock state is per workspace and survives session switches.
function handleToggleChanges() {
    if (isMobileViewport.value) {
        if (showMobileChanges.value && mobileAuxTab.value === "changes") {
            showMobileChanges.value = false;
            return;
        }
        mobileAuxTab.value = "changes";
        showMobileChanges.value = true;
    }
}

// PLAN-0507: the right-panel Monitor is the Chat default view (decision #4/#13).
function handleToggleMonitor() {
    if (isMobileViewport.value) {
        if (showMobileChanges.value && mobileAuxTab.value === "monitor") {
            showMobileChanges.value = false;
            return;
        }
        mobileAuxTab.value = "monitor";
        showMobileChanges.value = true;
    }
}

function handleWorkspaceCreated(id: string) {
    router.push(`/workspace/${id}`);
}

const routeSessionId = computed(() => (route.params.sessionId as string | undefined) ?? "");

const sessionId = computed(() => {
    const current = sessionStore.currentSession;
    if (routeSessionId.value) {
        return current?.id === routeSessionId.value && current.workspaceId === workspaceId.value
            ? current.id
            : null;
    }
    if (current?.workspaceId === workspaceId.value) return current.id;
    return null;
});

const activeAgentPrincipalId = computed(
    () =>
        sessionStore.sessions.find((session) => session.id === sessionId.value)?.agentPrincipalId ??
        null,
);

/** P1-2: the center header shows the session, never the workspace name again. */
const sessionTitle = computed(() => {
    const session = sessionStore.sessions.find((item) => item.id === sessionId.value);
    return session?.title ?? t("workspace.chatHeader");
});

const workspaceId = computed(() => routeWorkspaceId.value || auth.currentWorkspaceId || "");

const workspaceEvents = useWorkspaceSSE(workspaceId, {
    onEvent: (event) => ws.applyWorkspaceEvent(event),
});

let workspaceLoadSequence = 0;

async function selectSessionForWorkspace() {
    const targetWorkspaceId = workspaceId.value;
    if (!targetWorkspaceId) return null;
    const sequence = ++workspaceLoadSequence;
    try {
        await auth.selectWorkspace(targetWorkspaceId);
        if (sequence !== workspaceLoadSequence) return null;
        await sessionStore.loadSessions();
        if (sequence !== workspaceLoadSequence) return null;
        let existing = sessionStore.sessions.find(
            (session) =>
                session.workspaceId === targetWorkspaceId &&
                (routeSessionId.value ? session.id === routeSessionId.value : true),
        );
        if (!existing && routeSessionId.value) {
            const loaded = await sessionStore.loadSession(routeSessionId.value);
            if (sequence === workspaceLoadSequence && loaded.workspaceId === targetWorkspaceId) {
                existing = loaded;
            }
        }
        if (sequence !== workspaceLoadSequence) return null;
        if (existing) {
            sessionStore.selectSession(existing.id);
            return existing.id;
        }
        sessionStore.clearCurrentSession();
        return null;
    } catch (cause) {
        if (sequence !== workspaceLoadSequence) return null;
        const code = cause instanceof ApiError ? cause.problem.code : "";
        if (
            routeWorkspaceId.value === targetWorkspaceId &&
            (code === "WORKSPACE_FORBIDDEN" || code === "WORKSPACE_NOT_FOUND")
        ) {
            // Stale/deleted tab workspace: clear it so the home route can
            // bootstrap the default workspace without a redirect loop.
            await router.replace({ name: "workspace-home" });
            return null;
        }
        const message = cause instanceof ApiError ? cause.message : "Failed to load workspace";
        logger.error("Load workspace failed", cause);
        toast.error(message);
        return null;
    }
}

async function createSessionForWorkspace() {
    if (!workspaceId.value) await auth.hydrateWorkspace();
    if (!workspaceId.value) return null;
    try {
        await auth.selectWorkspace(workspaceId.value);
        workspaceAgents.value = await api.getWorkspaceAgents(workspaceId.value);
        if (workspaceAgents.value.length === 0) {
            toast.error(t("workspace.noBoundAgent"));
            return null;
        }
        selectedAgentPrincipalId.value = "";
        showAgentSelection.value = true;
        return null;
    } catch (cause) {
        const message =
            cause instanceof ApiError ? cause.message : "Failed to load Workspace Agents";
        logger.error("Load Workspace Agents failed", cause);
        toast.error(message);
        return null;
    }
}

async function confirmCreateAgentSession() {
    if (!workspaceId.value || !selectedAgentPrincipalId.value || creatingAgentSession.value) return;
    creatingAgentSession.value = true;
    try {
        const session = await sessionStore.createSession(selectedAgentPrincipalId.value);
        showAgentSelection.value = false;
        await router.push(workspaceChatPath(workspaceId.value, session.id));
        return session.id;
    } catch (cause) {
        const message = cause instanceof ApiError ? cause.message : "Failed to create session";
        logger.error("Create session failed", cause);
        toast.error(message);
        // PLAN-0608 (T1.5 / P0-2): a workspace-context rejection must be
        // recoverable, not a dead-end toast — send the user to the picker.
        const code = cause instanceof ApiError ? cause.problem.code : "";
        if (code === "WORKSPACE_CONTEXT_REQUIRED" || code === "WORKSPACE_CONTEXT_CONFLICT") {
            showAgentSelection.value = false;
            await router.push({ name: "workspace-home" });
        }
        return null;
    } finally {
        creatingAgentSession.value = false;
    }
}

watch(
    () => route.query.newChat,
    (request) => {
        if (request !== "1") return;
        void createSessionForWorkspace().finally(() => {
            void router.replace({ query: { ...route.query, newChat: undefined } });
        });
    },
    { immediate: true },
);

watch(
    () => sessionId.value,
    (id) => {
        if (id) sessionStore.selectSession(id);
    },
    { immediate: true },
);

// Keep the workspace store's per-session file selection in sync. The dock's
// `code` tab is opened by the workbench (it owns the dock state).
watch(
    () => ws.activeFilePath,
    () => {
        ws.syncActiveFileToSession();
    },
);

onMounted(() => {
    void selectSessionForWorkspace();
});

watch([workspaceId, routeSessionId], () => {
    void selectSessionForWorkspace();
});
</script>

<template>
    <!-- Empty state per PLAN-262 decision 11: only reachable when no active workspace.
       The create dialog is the sole creation entry (409 makes it purely defensive). -->
    <div
        v-if="!auth.workspace && !workspaceId"
        class="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
    >
        <div class="flex size-16 items-center justify-center rounded-2xl border border-dashed">
            <FolderTree class="size-7 text-muted-foreground" aria-hidden="true" />
        </div>
        <h2 class="text-lg font-semibold">暂无工作区</h2>
        <p class="max-w-sm text-sm text-muted-foreground">
            上一个工作区已删除。创建一个新的工作区开始使用文件、终端与 Agent 工具。
        </p>
        <button
            class="px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:opacity-90"
            @click="showCreateDialog = true"
        >
            创建工作区
        </button>
        <p class="max-w-md text-xs text-muted-foreground border-t border-dashed pt-3">
            每账号同时持有 1 个活动工作区 · 物理目录由系统按 hostRoot/workspaceId
            派生，宿主机可直接访问
        </p>
    </div>
    <div v-else class="flex h-full min-w-0">
        <WorkspaceWorkbench
            :workspace-id="workspaceId"
            :session-id="sessionId"
            :agent-principal-id="activeAgentPrincipalId"
            :is-mobile="isMobileViewport"
            :mobile-changes-open="showMobileChanges"
            :mobile-aux-tab="mobileAuxTab"
            @import-source="showSourceImportDialog = true"
            @agents="showAgentManagementDialog = true"
            @add-workspace="showCreateDialog = true"
            @files="showMobileFiles = true"
            @mobile-toggle-changes="handleToggleChanges"
            @mobile-toggle-monitor="handleToggleMonitor"
        >
            <template #center>
                <!-- Conversation is the main column; the workbench renders it for desktop. -->
                <div class="flex min-w-0 flex-1 flex-col" data-testid="workspace-conversation">
                    <div
                        class="h-9 shrink-0 border-b px-3 flex items-center gap-2 text-xs text-muted-foreground bg-muted/5"
                        :title="`workspace=${workspaceId}`"
                    >
                        <!-- S3a (review P1-2): the workspace name lives in the panel head
                           and the file-tree head only; this row is session-scoped. -->
                        <span
                            data-testid="workspace-session-title"
                            class="min-w-0 max-w-72 truncate font-medium text-foreground/80"
                            :data-workspace-id="auth.workspace?.id"
                            :data-role="auth.workspaceRole"
                            :data-can-write="String(auth.canWriteWorkspace)"
                            :title="sessionTitle"
                            >{{ sessionTitle }}</span
                        >
                        <span
                            v-if="!auth.canWriteWorkspace"
                            data-testid="workspace-viewer-badge"
                            class="rounded border border-amber-500/40 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300"
                        >
                            {{ t("workspace.viewerReadOnly") }}
                        </span>
                        <span
                            data-testid="workspace-event-status"
                            class="text-[10px]"
                            :class="
                                workspaceEvents.isConnected.value
                                    ? 'text-emerald-600'
                                    : 'text-muted-foreground/60'
                            "
                        >
                            {{
                                workspaceEvents.isConnected.value
                                    ? t("workspace.eventsConnected")
                                    : t("workspace.eventsReconnecting")
                            }}
                        </span>
                        <!-- PLAN-0343: run-terminal usage line (tokens · cost/unmapped · source badge) -->
                        <div
                            v-if="lastUsage && usageInput !== undefined"
                            class="ml-auto flex items-center gap-2 tabular-nums"
                        >
                            <span>in {{ usageInput }} · out {{ usageOutput ?? 0 }}</span>
                            <span
                                :title="usageCostTitle"
                                :class="
                                    lastUsage.cost == null && usageCost !== '—'
                                        ? 'text-amber-500'
                                        : ''
                                "
                            >
                                {{ usageCost }}
                            </span>
                            <span
                                v-if="usageSource"
                                class="rounded border px-1 py-0.5 text-[10px] leading-none"
                                :class="
                                    usageSource === 'real'
                                        ? 'border-emerald-500/40 text-emerald-600'
                                        : 'border-amber-500/40 text-amber-600'
                                "
                            >
                                {{ usageSource }}
                            </span>
                        </div>
                    </div>
                    <ChatPanel v-if="sessionId" :session-id="sessionId" tool-mode="workspace" />
                    <div v-else class="flex flex-1 flex-col items-center justify-center gap-2">
                        <p class="text-sm text-muted-foreground">{{ t("workspace.noSession") }}</p>
                        <button
                            class="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90"
                            data-testid="workspace-create-session"
                            @click="createSessionForWorkspace()"
                        >
                            {{ t("workspace.createSession") }}
                        </button>
                    </div>
                </div>
            </template>
        </WorkspaceWorkbench>

        <FileImportDialog v-if="ws.showImportDialog" />
        <WorkspaceSourceImportDialog
            :open="showSourceImportDialog"
            :workspace-id="workspaceId"
            @close="showSourceImportDialog = false"
            @completed="
                showSourceImportDialog = false;
                void ws.refreshTree();
            "
        />

        <WorkspaceAgentManagementDialog
            :open="showAgentManagementDialog"
            :workspace-id="workspaceId"
            @close="showAgentManagementDialog = false"
        />

        <MobileWorkspaceSheet
            :open="showMobileFiles"
            @close="showMobileFiles = false"
            @add-workspace="showCreateDialog = true"
        />

        <MobileChangesSheet
            :open="showMobileChanges"
            :session-id="sessionId"
            :workspace-id="workspaceId"
            :tab="mobileAuxTab"
            @update:tab="mobileAuxTab = $event"
            @close="showMobileChanges = false"
        />

        <MobileChatSheet v-if="sessionId" :session-id="sessionId" />

        <BaseModal
            :show="showAgentSelection"
            :title="t('workspace.chooseAgentTitle')"
            @close="showAgentSelection = false"
        >
            <div class="space-y-4">
                <label for="workspace-agent-principal" class="block text-sm text-foreground">
                    {{ t("workspace.chooseAgentLabel") }}
                </label>
                <select
                    id="workspace-agent-principal"
                    v-model="selectedAgentPrincipalId"
                    data-testid="workspace-agent-principal-select"
                    class="w-full rounded-md border bg-background px-3 py-2 text-sm"
                >
                    <option value="" disabled>{{ t("workspace.chooseAgentPlaceholder") }}</option>
                    <option
                        v-for="agent in workspaceAgents"
                        :key="agent.principalId"
                        :value="agent.principalId"
                    >
                        {{ agent.name
                        }}<template v-if="agent.templateName"> · {{ agent.templateName }}</template>
                    </option>
                </select>
                <div class="flex justify-end gap-2">
                    <button
                        type="button"
                        class="rounded-md border px-3 py-2 text-sm"
                        @click="showAgentSelection = false"
                    >
                        {{ t("workspace.cancel") }}
                    </button>
                    <button
                        type="button"
                        data-testid="workspace-create-agent-session"
                        class="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
                        :disabled="!selectedAgentPrincipalId || creatingAgentSession"
                        @click="confirmCreateAgentSession"
                    >
                        {{ t("workspace.createSession") }}
                    </button>
                </div>
            </div>
        </BaseModal>
    </div>

    <!-- PLAN-0384 T1.1: one creation entry for both the empty state and existing workspaces. -->
    <WorkspaceCreateDialog
        :open="showCreateDialog"
        @close="showCreateDialog = false"
        @created="handleWorkspaceCreated"
    />
</template>
