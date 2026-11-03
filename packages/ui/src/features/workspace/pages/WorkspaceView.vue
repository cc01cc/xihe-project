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
import { clearTabWorkspace } from "../../../lib/workspaceContext";
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

/**
 * D26/D27：只有**已绑定且未禁用**的 agent 才能建会话 ——
 * 未绑定 → CP 403「not bound」；已禁用 → CP 409 `AGENT_PRINCIPAL_DISABLED`。
 * 把它们列出来等于把用户送进一个必然失败的点击。
 */
/** D27：空选择的原因（"none-bound" 未绑定 / "all-disabled" 已绑定但全被禁用）。 */
const agentUnavailableReason = ref<"" | "none-bound" | "all-disabled">("");

const boundWorkspaceAgents = computed(() =>
    workspaceAgents.value.filter((agent) => agent.bound === true && agent.disabled !== true),
);

/** PLAN-0623：dock 参与者面板的「提及」→ composer 草稿（不发送）。 */
const chatPanelRef = ref<InstanceType<typeof ChatPanel> | null>(null);

function handleParticipantMention(name: string): void {
    chatPanelRef.value?.insertMention?.(name);
}

/**
 * PLAN-0626 M2: the chat summary row is the entry to the dock's `context` panel.
 * The chat column is this page's slot content, so its event lands here; the dock is
 * owned by `WorkspaceWorkbench`, which exposes `openDockTab` for exactly this hop.
 */
const workbenchRef = ref<InstanceType<typeof WorkspaceWorkbench> | null>(null);

function handleOpenContextPanel(): void {
    workbenchRef.value?.openDockTab("context");
}

/**
 * PLAN-0626 M3 (D26-05): the workspace Agent management surface is a dock panel. Every
 * desktop entry (toolbar button, "no usable agent" hint) opens the `agents` tab; only
 * mobile — which has no dock — falls back to the modal shell around the same panel body.
 * There is deliberately no desktop path that mounts a second copy of the panel.
 */
function handleOpenAgentsPanel(): void {
    if (isMobileViewport.value) {
        showAgentManagementDialog.value = true;
        return;
    }
    workbenchRef.value?.openDockTab("agents");
}

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
        // PLAN-0622 D26/D27：列表是三类并集；未绑定 → CP 403 not bound，已禁用 → CP 409。
        // 两者都不可选，但**原因不同**，对用户必须分开说（错误归因会让人去重复绑定）。
        if (boundWorkspaceAgents.value.length === 0) {
            const anyBound = workspaceAgents.value.some((agent) => agent.bound === true);
            agentUnavailableReason.value = anyBound ? "all-disabled" : "none-bound";
            toast.error(t(anyBound ? "workspace.noEnabledAgent" : "workspace.noBoundAgent"));
            return null;
        }
        agentUnavailableReason.value = "";
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
            // BL-172: clear the tab context before going back to the picker. The router
            // guard's workspace-home branch re-redirects to `/workspace/<tabId>` whenever a
            // tab context exists, so leaving it set turned this recovery into a bounce loop
            // (and the picker's early-return branch then never cleared its loading state).
            clearTabWorkspace();
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

// The mobile modal is only a dock substitute: once the viewport is wide enough for the
// dock, drop it so a resize can never leave two hosts eligible at the same time.
watch(isMobileViewport, (mobile) => {
    if (!mobile) showAgentManagementDialog.value = false;
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
            class="px-4 py-2 text-sm rounded bg-action text-action-foreground hover:opacity-90"
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
            ref="workbenchRef"
            :workspace-id="workspaceId"
            :session-id="sessionId"
            :agent-principal-id="activeAgentPrincipalId"
            :is-mobile="isMobileViewport"
            :mobile-changes-open="showMobileChanges"
            :mobile-aux-tab="mobileAuxTab"
            @import-source="showSourceImportDialog = true"
            @agents="handleOpenAgentsPanel"
            @add-workspace="showCreateDialog = true"
            @files="showMobileFiles = true"
            @mobile-toggle-changes="handleToggleChanges"
            @mobile-toggle-monitor="handleToggleMonitor"
            @mention="handleParticipantMention"
        >
            <template #center>
                <!-- Conversation is the main column; the workbench renders it for desktop.
                     `min-h-0` is load-bearing: as a flex item this column must be allowed to
                     shrink to the row height. Without it `min-height:auto` makes it grow to the
                     transcript's content height, `h-full` inside it resolves to that height
                     instead of the viewport's, and the message scroller ends up as tall as all
                     messages (60 of them ⇒ `scrollHeight == clientHeight`, nothing scrolls). -->
                <div
                    class="flex min-h-0 min-w-0 flex-1 flex-col"
                    data-testid="workspace-conversation"
                >
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
                    <!-- PLAN-0622 D27：工作区没有「可用」agent 时必须说明**真实原因**，
                         不能一律说"尚未绑定"（用户会去重复绑定一个已经绑好的 agent）。 -->
                    <div
                        v-if="agentUnavailableReason"
                        class="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700"
                        data-testid="workspace-agent-unavailable-hint"
                    >
                        <span>
                            {{
                                agentUnavailableReason === "all-disabled"
                                    ? t("workspace.noEnabledAgent")
                                    : t("workspace.noBoundAgent")
                            }}
                        </span>
                        <button
                            type="button"
                            class="rounded border border-amber-500/50 px-2 py-0.5"
                            data-testid="workspace-agent-unavailable-manage"
                            @click="handleOpenAgentsPanel"
                        >
                            {{ t("workspace.openAgentManagement") }}
                        </button>
                    </div>
                    <ChatPanel
                        v-if="sessionId"
                        ref="chatPanelRef"
                        :session-id="sessionId"
                        tool-mode="workspace"
                        @open-context-panel="handleOpenContextPanel"
                    />
                    <div v-else class="flex flex-1 flex-col items-center justify-center gap-2">
                        <p class="text-sm text-muted-foreground">{{ t("workspace.noSession") }}</p>
                        <button
                            class="px-3 py-1.5 text-xs rounded bg-action text-action-foreground hover:opacity-90"
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

        <!--
            PLAN-0626 M3 (D26-05): mobile-only host. A <768 viewport has no dock, so the same
            panel body is wrapped in a modal here; `v-if` guarantees a desktop page never holds
            a second copy next to the dock's (duplicate-mount incident, 2026-11-02).
        -->
        <WorkspaceAgentManagementDialog
            v-if="isMobileViewport"
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
                        v-for="agent in boundWorkspaceAgents"
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
                        class="rounded-md bg-action px-3 py-2 text-sm text-action-foreground disabled:opacity-50"
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
