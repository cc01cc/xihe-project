<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import { useSessionStore } from "../../../stores/session";
import { useWorkspaceConnectionStore } from "../../../stores/workspaceConnection";
import { useAuthStore } from "../../../stores/auth";
import { useChatStore } from "../chat/stores/chat";
import { ApiError, api, type WorkspaceAgentBinding } from "../../../composables/api";
import { useWorkspaceSSE } from "../composables/useWorkspaceSSE";
import { logger } from "../../../lib/logger";
import { causeErrorToastText, problemDetailText } from "../../../lib/errorMessages";
import { clearTabWorkspace } from "../../../lib/workspaceContext";
import { toast } from "vue-sonner";
import { FolderTree, PanelRightClose, PanelRightOpen } from "@lucide/vue";
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
import SseSubscriberLimitNotice from "../components/SseSubscriberLimitNotice.vue";
import { workspaceSessionPath } from "../../../lib/routes";
import BaseModal from "../../../components/shared/BaseModal.vue";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

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

/**
 * task-160 / `D-1527` ①：底部状态栏搬到壳层后，**用量**也和连接态一样是页面级读数，
 * 由本页发布、壳层只读。`0` 是有效读数（有 run 但 0 token），所以只在「无 run」时传 `null`。
 */
const connectionReadout = useWorkspaceConnectionStore();
watch(
    [usageInput, usageOutput],
    ([input, output]) => {
        connectionReadout.publishUsage(input ?? null, output ?? null);
    },
    { immediate: true },
);

const routeWorkspaceId = computed(() => {
    const value = route.params.workspaceId as string | undefined;
    return value && value !== "new" ? value : "";
});
/**
 * task-936（R67）：只有会话路由才由本页顶栏承载右栏开关。
 * 工作区首页（name=`workspace`）仍由 `WorkspaceWorkbench` 的容器页签行承担，
 * 否则同一屏会出现两颗（2026-11-24 真浏览器实测 root 页 2 颗）。
 */
const onSessionRoute = computed(() => route.name === "workspace-session");

const showCreateDialog = ref(false),
    showAgentManagementDialog = ref(false);
const showSourceImportDialog = ref(false),
    showMobileFiles = ref(false),
    showMobileChanges = ref(false),
    mobileAuxTab = ref<"monitor" | "changes" | "members">("monitor");
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

/**
 * BL-317 / D-198：溢出菜单的成员入口（**保留作兜底**，BL-317b 不改它的落点）。
 *
 * BL-317b 的新主入口是标题区的「头像堆叠 + 人数 + @N」→ `MobileMembersSheet`（独立高 sheet）。
 * 这里刻意仍走 aux tab：`e2e/mock/bl317-mobile-members.spec.ts` 覆盖了这条既有路径，
 * Lead 的验收口径要求它「跑通不改」——两个入口最终复用**同一个** `SessionParticipantsPanel`。
 */
function handleToggleMembers() {
    if (isMobileViewport.value) {
        if (showMobileChanges.value && mobileAuxTab.value === "members") {
            showMobileChanges.value = false;
            return;
        }
        mobileAuxTab.value = "members";
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
/**
 * task-928：CP 对「解析不出可用默认智能体」的 400 带一句**可操作**文案（改默认的端点与配置键）。
 * 它是唯一能解释「为什么连默认值都进不去」的信息源 ⇒ 原样上屏，不吞、不改写成「尚未绑定」。
 */
const agentSessionNotice = ref("");

const boundWorkspaceAgents = computed(() =>
    workspaceAgents.value.filter((agent) => agent.bound === true && agent.disabled !== true),
);

/** PLAN-0623：dock 参与者面板的「提及」→ composer 草稿（不发送）。 */
const chatPanelRef = ref<InstanceType<typeof ChatPanel> | null>(null);

function handleParticipantMention(name: string): void {
    chatPanelRef.value?.insertMention?.(name);
}

/**
 * D-1907 rev10：聊天列摘要行（`session-settings-summary`）= **会话配置页签的快捷开关**
 * （rev2：不再是面板本体/折叠态）。点一下在右栏容器里开 `pane:right:session-config:<sid>`，
 * 已开则聚焦、不重复开 —— 判定归 `WorkspaceWorkbench#openSessionConfigTab`（与右键「+」
 * 选同一项同一条路）。
 *
 * <p>事件名保留 `open-context-panel`：它是 ChatPanel/SessionSettingsPanel 的既有契约
 * （vitest 与真实 e2e 都按它钉），改名的收益只是好读，代价是一圈消费点漂移。</p>
 */
const workbenchRef = ref<InstanceType<typeof WorkspaceWorkbench> | null>(null);
/**
 * task-936（R67）：会话页顶栏的右栏开关。
 *
 * <p>状态只由 `WorkspaceWorkbench` 持有（`layout.dockCollapsed` 的单一 writer），这里经
 * `defineExpose` 读同一份；**不复制**第二个 ref，也不落第二把 localStorage 键。</p>
 */
const workbenchDockOpen = computed(() => workbenchRef.value?.dockOpen ?? false);
function toggleWorkbenchDock(): void {
    workbenchRef.value?.toggleDock();
}

function handleOpenContextPanel(): void {
    workbenchRef.value?.openSessionConfigTab(sessionId.value);
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

/** P1-2: the center header shows the session, never the workspace name again. */
const sessionTitle = computed(() => {
    const session = sessionStore.sessions.find((item) => item.id === sessionId.value);
    return session?.title ?? t("workspace.chatHeader");
});

const workspaceId = computed(() => routeWorkspaceId.value || auth.currentWorkspaceId || "");

const workspaceEvents = useWorkspaceSSE(workspaceId, {
    onEvent: (event) => ws.applyWorkspaceEvent(event),
});

/**
 * PLAN-0676 T2：`limit` 态由壳级横幅（`AppLayout` 里的 `<SseSubscriberLimitNotice />`，读模块级
 * 状态）负责，页面只补 `disconnected` / `reconnecting`——否则同一条链路会上下叠两个横幅。
 */
const pageNoticeState = computed(() => {
    const state = workspaceEvents.noticeState.value;
    return state && state !== "limit" ? state : undefined;
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
        // task-846：不再把 CP 英文 detail 当 toast 主文案；本地化文案 + 稳定错误码。
        const message = causeErrorToastText(t, cause, t("workspace.loadFailed"));
        logger.error("Load workspace failed", cause);
        toast.error(message);
        return null;
    }
}

/**
 * task-116（方案 A UI 侧）：用某个主体建会话。默认值路径与手动选择路径共用这一份，
 * 否则 400 回退与工作区上下文恢复很快就会只修好一边。
 *
 * <p>`fallbackOnMissingDefault` 只在「拿默认值直接进」这条路上为 true：CP 用 400 表示
 * 「没有可用的默认值」，那不是故障而是**回退信号**；手动选择路径上的 400 仍按普通失败 toast，
 * 否则用户会以为再选一次就能成功。其它状态码（403/409/5xx）一律照旧 toast + 上下文恢复。</p>
 */
async function submitAgentSession(
    agentPrincipalId: string,
    fallbackOnMissingDefault: boolean,
): Promise<{ id: string | null; missingDefault: boolean }> {
    if (!workspaceId.value || creatingAgentSession.value) {
        return { id: null, missingDefault: false };
    }
    creatingAgentSession.value = true;
    try {
        const session = await sessionStore.createSession(agentPrincipalId);
        showAgentSelection.value = false;
        await router.push(workspaceSessionPath(workspaceId.value, session.id));
        return { id: session.id, missingDefault: false };
    } catch (cause) {
        const status = cause instanceof ApiError ? cause.problem.status : undefined;
        if (fallbackOnMissingDefault && status === 400) {
            // 默认值失效（被取消/被禁用/尚无默认）⇒ 回到手动选择，不算失败。
            // task-928：但**服务端那句可操作文案必须上屏** —— 「尚未绑定」是本地猜测，
            // CP 的文案才是用户能执行的下一步（改默认 / 配置默认主体）。
            agentSessionNotice.value = problemDetailText(cause, "");
            logger.warn("Workspace default Agent rejected; falling back to the picker", cause);
            return { id: null, missingDefault: true };
        }
        const message = causeErrorToastText(t, cause, t("workspace.createSessionFailed"));
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
        return { id: null, missingDefault: false };
    } finally {
        creatingAgentSession.value = false;
    }
}

async function createSessionForWorkspace() {
    if (!workspaceId.value) await auth.hydrateWorkspace();
    if (!workspaceId.value) return null;
    try {
        await auth.selectWorkspace(workspaceId.value);
        workspaceAgents.value = await api.getWorkspaceAgents(workspaceId.value);
    } catch (cause) {
        // 列表**读失败** ≠ 没有绑定：403/网络失败必须说「读不到」，不能伪装成「尚未绑定」。
        const message = causeErrorToastText(t, cause, t("workspace.agentsLoadFailed"));
        logger.error("Load Workspace Agents failed", cause);
        toast.error(message);
        return null;
    }
    agentUnavailableReason.value = "";
    agentSessionNotice.value = "";
    // task-116（方案 A）：本地有默认智能体就带上它，省掉一步选择；标记只认服务端列表
    // （`isDefault`），不做本地缓存/乐观默认。
    const defaultAgent = boundWorkspaceAgents.value.find((agent) => agent.isDefault === true);
    // task-928（用户裁定）：前端**不得**本地判空后 return —— 默认链由 CP 解析
    // （env > 管理员锁定 > workspace-default-binding > workspace > workspace-default > user > instance）。
    // 本地没有默认时传空串，让 CP 决定；解析不出时 CP 的 400 文案直接上屏。
    const result = await submitAgentSession(defaultAgent?.principalId ?? "", true);
    if (!result.missingDefault && result.id) return result.id;
    if (!result.missingDefault) return null;
    // 回退到手动选择：原因按列表**事实**分两类，且只在 CP 说「没有可用默认」后才说 ——
    // 这不是前端短路，是服务端结论的呈现。
    agentUnavailableReason.value = workspaceAgents.value.some((agent) => agent.bound === true)
        ? "all-disabled"
        : "none-bound";
    selectedAgentPrincipalId.value = "";
    showAgentSelection.value = true;
    return null;
}

async function confirmCreateAgentSession() {
    if (!selectedAgentPrincipalId.value) return null;
    const result = await submitAgentSession(selectedAgentPrincipalId.value, false);
    return result.id;
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

/**
 * D-1220 ②（task-365 B）：导入源对话框的入口从左栏「工作区」区头来（`?importSource=1`），
 * 页内工具栏不再放这个按钮。消费后抹掉参数，与 `?newChat=1` 同形。
 */
/**
 * `?create=1` 在**两个宿主**都要消费：无 tab 上下文时 `/workspace` 渲染 `WorkspacePicker`，
 * 有上下文时路由守卫把它重定向到 `/workspace/{id}`（query 原样带过来，`router/index.ts:486`）
 * ⇒ 只在 Picker 里消费的话，「已经在工作区里点区头 +」会**点了没反应**（对话框根本不挂载）。
 */
watch(
    () => route.query.create,
    (request) => {
        if (request !== "1") return;
        showCreateDialog.value = true;
        void router.replace({ query: { ...route.query, create: undefined } });
    },
    { immediate: true },
);

watch(
    () => route.query.importSource,
    (request) => {
        if (request !== "1") return;
        showSourceImportDialog.value = true;
        void router.replace({ query: { ...route.query, importSource: undefined } });
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

// 移动端宿主都是 dock 的**替身**：一旦视口宽到能放 dock，就撤掉替身 —— 两个宿主同时活着时，
// 它们各自挂的 `SessionContextPanel` 会把 `session-settings-expanded` 变成 2 个节点。
//
// task-116 补漏：这条判据 2026-11-02 只覆盖了 agent 管理弹窗；`MobileChatSheet` 同样常挂在页面里
// （只按 `sessionId` gate，不看视口），而它的触发器是 `md:hidden` —— CSS 隐藏触发器不等于收回
// 已打开的内容。
//
// task-124（D-979 第二种假绿）：**收口拆成两层**，且顺序不能颠倒 ——
// ① **结构性互斥**是主判据：下面模板里三台替身（文件 / 改动·监控·成员 / 会话）都由
//    `v-if`/`isMobileNow` 决定**存不存在**，桌面视口下它们结构上不在 DOM 里 ⇒ 不依赖"记得写 watch"；
// ② **状态归位**是这个 watch 的唯一职责（下面几个 `= false`）：防止"回到移动视口后旧 sheet 又自己
//    弹开"。**它不再是防重复的主力**，删掉它不会产生重复（只会留下关着的旧状态）。
// 依赖核实（task-124，结构性改造前置）：`showMobileFiles`/`showMobileChanges` 只喂 `:open` 与
// `WorkspaceWorkbench :mobile-changes-open`/`:mobile-aux-tab`；两台 sheet 内**无我们写的** focus 归还、
// **无** `Teleport`、**无** `onMounted` 副作用（`grep` 见证据）⇒ 结构性移除不会破坏交互。
//
// task-56 更正上面那句的**适用范围**（别读成「抽屉没有焦点回位」）：回位是 **reka 原语提供的**
// （`dist/Dialog/DialogContentModal.js` 关闭时 `triggerElement.value?.focus()`），files/chat 两台
// 触发器常驻 ⇒ 默认行为就正确。但 changes/monitor 的入口在**溢出菜单**里、选中即卸载触发器
// ⇒ 默认回位落空到 `body`，故 `MobileChangesSheet` 需要显式 `@close-auto-focus` 把焦点还给常驻的
// `workspace-toolbar-more-mobile`。「我们的代码里没有显式 focus 归还」这半句在 task-56 之前成立，
// 现在只对 files/chat 成立。
watch(isMobileViewport, (mobile) => {
    if (mobile) return;
    showAgentManagementDialog.value = false;
    showMobileFiles.value = false;
    showMobileChanges.value = false;
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
        <h2 class="text-lg font-semibold">{{ t("workspace.noWorkspaceTitle") }}</h2>
        <p class="max-w-sm text-sm text-muted-foreground">
            {{ t("workspace.noWorkspaceBody") }}
        </p>
        <!-- PLAN-0631 反馈②：低频可逆的「创建工作区」入口不配主按钮层级，中性 ghost。 -->
        <button
            class="px-4 py-2 text-sm rounded border text-foreground transition-colors hover:bg-accent"
            @click="showCreateDialog = true"
        >
            {{ t("workspace.noWorkspaceCreate") }}
        </button>
        <p class="max-w-md text-xs text-muted-foreground border-t border-dashed pt-3">
            {{ t("workspace.noWorkspaceFootnote") }}
        </p>
    </div>
    <div v-else class="flex h-full min-w-0">
        <WorkspaceWorkbench
            ref="workbenchRef"
            :workspace-id="workspaceId"
            :session-id="sessionId"
            :is-mobile="isMobileViewport"
            :sse-connecting="workspaceEvents.isConnecting.value"
            :mobile-changes-open="showMobileChanges"
            :mobile-aux-tab="mobileAuxTab"
            @agents="handleOpenAgentsPanel"
            @files="showMobileFiles = true"
            @mobile-toggle-changes="handleToggleChanges"
            @mobile-toggle-monitor="handleToggleMonitor"
            @mobile-toggle-members="handleToggleMembers"
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
                    <!-- PLAN-0676 T2：SSE 链路三态横幅（limit / disconnected / reconnecting）。
                       这是「事件流出问题但页面看起来正常」的唯一可见出口——t56 的 BL-335 只覆盖
                       了 limit 态，disconnected/reconnecting 之前完全不可见。 -->
                    <!-- PLAN-0712 / BL-335 dedupe: pageNoticeState is undefined for `limit`
                        (the shell AppLayout banner owns it); rendering the component with an
                        undefined state would fall back to the module-level limit flag and
                        duplicate the shell banner. Render page-level only for the other two
                        states. -->
                    <SseSubscriberLimitNotice
                        v-if="pageNoticeState"
                        :state="pageNoticeState"
                        :code="workspaceEvents.connectionErrorCode.value ?? undefined"
                        :workspace-name="auth.workspace?.name"
                        :on-retry="workspaceEvents.retry"
                    />
                    <!--
                        会话头 = 页面身份行（task-134 / DSD-1507 ①）。**状态不在这里**：
                        原 task-60 F-1 的「文件事件已连接」徽标（workspace-event-status）与
                        「只限启动目录」提示（session-sandbox-enforcement）都搬到下面底部状态栏
                        （WorkspaceStatusBar：连接态沿用同一条派生链 useWorkspaceEventStatus，
                        沙箱读数只在 windows-host 无 FS 限制时占位）。用户原话（2026-11-20）：
                        「毫无意义、状态应在底部」。

                        task-936（R66/R67/R69）：这条行的职责再收敛一次 ——
                        ① 标题只保留 `sr-only` 版本（可见标题唯一归属容器页签行，避免同名两处）；
                        ② token/费用/来源整段下沉到底部状态栏（`WorkspaceStatusBar` 已渲染 in/out），
                        本行不再承载任何计量；
                        ③ 右栏开合开关从「主栏容器页签行」迁到这里（会话页顶栏右侧），
                        状态仍由 `WorkspaceWorkbench` 单一持有（`defineExpose` 暴露，不复制第二份）。
                    -->
                    <div
                        class="h-8 shrink-0 border-b px-3 flex items-center gap-2 text-xs text-muted-foreground bg-muted/5"
                        :title="`workspace=${workspaceId}`"
                    >
                        <!--
                            S3a (review P1-2): 工作区名只在面板头与文件树头出现；本行是会话级。
                            task-936：可见标题已由容器页签行承担，这里保留 `sr-only` 标题作为
                            会话页的可访问标题（e2e 也以它作稳定锚点），视觉上不再重复。
                        -->
                        <span
                            data-testid="workspace-session-title"
                            class="sr-only"
                            :data-workspace-id="auth.workspace?.id"
                            :data-role="auth.workspaceRole"
                            :data-can-write="String(auth.canWriteWorkspace)"
                            :title="sessionTitle"
                            >{{ sessionTitle }}</span
                        >
                        <span
                            v-if="!auth.canWriteWorkspace"
                            data-testid="workspace-viewer-badge"
                            class="rounded border border-amber-500/40 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300"
                        >
                            {{ t("workspace.viewerReadOnly") }}
                        </span>
                        <!--
                            task-936（R67）：会话页顶栏唯一的右栏开合开关。
                            `aria-pressed` 与容器页签行同源（`WorkspaceWorkbench#dockOpen`），
                            容器行那颗在本路由不渲染（见 WorkspaceWorkbench），所以同一屏只有一颗。
                        -->
                        <button
                            v-if="sessionId && onSessionRoute"
                            type="button"
                            data-testid="workspace-dock-toggle"
                            class="ml-auto inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            :aria-pressed="workbenchDockOpen"
                            :aria-label="
                                workbenchDockOpen
                                    ? t('workspace.dockToggleClose')
                                    : t('workspace.dockToggleOpen')
                            "
                            :title="
                                workbenchDockOpen
                                    ? t('workspace.dockToggleClose')
                                    : t('workspace.dockToggleOpen')
                            "
                            @click="toggleWorkbenchDock"
                        >
                            <PanelRightClose
                                v-if="workbenchDockOpen"
                                class="size-3.5"
                                aria-hidden="true"
                            />
                            <PanelRightOpen v-else class="size-3.5" aria-hidden="true" />
                        </button>
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
                    <!-- task-928：CP 解析不出可用默认时的可操作文案（原样上屏，不改写）。 -->
                    <div
                        v-if="agentSessionNotice"
                        class="mx-4 mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700"
                        data-testid="workspace-agent-session-notice"
                    >
                        {{ agentSessionNotice }}
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

        <!-- task-124：结构性互斥 —— 桌面视口下这台替身**根本不存在**（原先只靠 `md:hidden`
             藏触发器，已打开的内容仍会留在 DOM 里）。`showMobileFiles` 只作打开状态。 -->
        <MobileWorkspaceSheet
            v-if="isMobileViewport"
            :open="showMobileFiles"
            @close="showMobileFiles = false"
            @add-workspace="showCreateDialog = true"
        />

        <MobileChangesSheet
            v-if="isMobileViewport"
            :open="showMobileChanges"
            :session-id="sessionId"
            :workspace-id="workspaceId"
            :tab="mobileAuxTab"
            @update:tab="mobileAuxTab = $event"
            @close="showMobileChanges = false"
        />

        <MobileChatSheet v-if="sessionId" :session-id="sessionId" :is-mobile="isMobileViewport" />

        <BaseModal
            :show="showAgentSelection"
            :title="t('workspace.chooseAgentTitle')"
            @close="showAgentSelection = false"
        >
            <div class="space-y-4">
                <label for="workspace-agent-principal" class="block text-sm text-foreground">
                    {{ t("workspace.chooseAgentLabel") }}
                </label>
                <!-- task-928：没有可选的已绑定主体时给明确空态（不是死路：右侧有打开管理入口）。 -->
                <div
                    v-if="boundWorkspaceAgents.length === 0"
                    data-testid="workspace-agent-picker-empty"
                    class="space-y-2 rounded-md border border-dashed p-3 text-xs text-muted-foreground"
                >
                    <p>{{ t("workspace.chooseAgentEmpty") }}</p>
                    <button
                        type="button"
                        class="rounded border border-amber-500/50 px-2 py-0.5 text-amber-700"
                        data-testid="workspace-agent-picker-manage"
                        @click="
                            showAgentSelection = false;
                            handleOpenAgentsPanel();
                        "
                    >
                        {{ t("workspace.openAgentManagement") }}
                    </button>
                </div>
                <Select v-else v-model="selectedAgentPrincipalId">
                    <SelectTrigger
                        id="workspace-agent-principal"
                        data-testid="workspace-agent-principal-select"
                        class="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                        <SelectValue :placeholder="t('workspace.chooseAgentPlaceholder')" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem
                            v-for="agent in boundWorkspaceAgents"
                            :key="agent.principalId"
                            :value="agent.principalId"
                        >
                            {{ agent.name
                            }}<template v-if="agent.templateName">
                                · {{ agent.templateName }}</template
                            >
                        </SelectItem>
                    </SelectContent>
                </Select>
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
