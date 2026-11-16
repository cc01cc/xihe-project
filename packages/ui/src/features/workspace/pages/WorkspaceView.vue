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
import SseSubscriberLimitNotice from "../components/SseSubscriberLimitNotice.vue";
import { workspaceChatPath } from "../../../lib/routes";
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
const usageSource = computed(() => lastUsage.value?.source);

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
/**
 * task-52 / batch-02（P1）：用量行里的 `未映射` 与 `real` 曾是**裸字面量**。
 *
 * <p>现象（截图 `.tmp/xh/b02-10-chat-full.png`）：中文界面底部读出
 * `in 3591 · out 8 未映射 real` —— 前两段是英文 wire 值。而`未映射`本身是
 * **设计行为**（CP `UsageCostMapper.withCost` 在没有 token 计数或模型不在定价表时
 * 返回 `cost=null` + `costSource="unmapped"`），不是缺陷；因此这里**只改文案**，
 * 不动 CP、也不凭空写出 `$0`（那会把"没有定价"说成"这次免费"）。</p>
 *
 * <p>口径沿用 `WorkspaceEnvironmentView` 的枚举处理先例（task-59 / D-1442）：
 * **可见文本走 i18n，wire 原值只进 `title`** —— 人看人话、排障看属性，两边都不丢。</p>
 */
const USAGE_SOURCE_KEY: Record<string, string> = {
    real: "workspace.usageSourceReal",
    estimated: "workspace.usageSourceEstimated",
    fallback: "workspace.usageSourceFallback",
};

/** CP `costNote` 的原值是英文（`UsageCostMapper`），映射层放在前端，不改后端。 */
const USAGE_COST_NOTE_KEY: Record<string, string> = {
    "no token counts": "workspace.usageCostNoteNoTokenCounts",
    "model not in pricing config": "workspace.usageCostNoteNoPricing",
    "no pricing entry": "workspace.usageCostNoteNoPricing",
};

const usageCost = computed(() => {
    const usage = lastUsage.value;
    if (!usage) return null;
    if (usage.cost == null) {
        // `fallback` = 这一轮根本没有 token 计数（CP 明说 `no token counts`）⇒ 用破折号而不是
        // 「未映射」：前者是「没有这个读数」，后者是「有数但没定价」，两件事不该同一个词。
        return usage.source === "fallback" ? "—" : t("workspace.usageCostUnmapped");
    }
    return `$${usage.cost}`;
});
const usageCostTitle = computed(() => {
    const usage = lastUsage.value;
    if (!usage || usage.cost != null) return "";
    const mapped = usage.costNote ? USAGE_COST_NOTE_KEY[usage.costNote] : undefined;
    // 未登记的新 note 回落通用句，原值仍留在下方 `usage-cost-raw` 属性里可查。
    return t(mapped ?? "workspace.usageCostNoteUnknown");
});
const usageSourceLabel = computed(() => {
    const source = usageSource.value;
    if (!source) return "";
    const key = USAGE_SOURCE_KEY[source];
    return key ? t(key) : source;
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
// `WorkspaceWorkbench :mobile-changes-open`/`:mobile-aux-tab`；两台 sheet 内**无** focus 归还、
// **无** `Teleport`、**无** `onMounted` 副作用（`grep` 见证据）⇒ 结构性移除不会破坏交互。
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
        <h2 class="text-lg font-semibold">暂无工作区</h2>
        <p class="max-w-sm text-sm text-muted-foreground">
            上一个工作区已删除。创建一个新的工作区开始使用文件、终端与 Agent 工具。
        </p>
        <!-- PLAN-0631 反馈②：低频可逆的「创建工作区」入口不配主按钮层级，中性 ghost。 -->
        <button
            class="px-4 py-2 text-sm rounded border text-foreground transition-colors hover:bg-accent"
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
                        task-550（Q-i 第二半，用户裁定）：**会话头常显**「无文件系统授权限制（只限启动目录，不限读写范围）」。
                        为什么常显而不是 tooltip：这条限制会持续影响「为什么工具能跑但产物不在工作区」这类判断，
                        藏进 hover 等于只在用户想起来要看的时候才存在。
                        为什么两行：主文案 24 个汉字 / 48 列（task-7 前是 21 字 / 42 列 —— 旧注释写「22 个汉字」是错数），
                        塞进 36px 单行头部会在窄档被 truncate，而后半句（限定）恰恰最容易被截掉 ——
                        它正是防止「以为完全没有边界」的那半句。
                        task-7（2026-11-15，Lead 裁 A 版）：括号里原写「工作区路径边界仍生效」，读起来像
                        「文件被限制在工作区内」；实测只约束 cwd（job_engine/mod.rs:1108-1141），故只写「只限启动目录」。
                        B 版（补「以你的系统账户身份运行」）被否：+19 列会触发 1024 档折行；详见 i18n 侧注释。
                    -->
                    <!--
                        task-255 / D-1631 —— **这条提示必须限高两行**。
                        实测（probe-note，4/4 迭代同形）：会话列在 splitter 面板宽度落定前
                        `clientWidth = 0`，本条 `shrink-0` 提示的内容盒只有 21px 宽，
                        51 个字符按 12px/19.2px 折成 ~31 行 ⇒ **高 602px**（稳态约 47px）。
                        它不可压缩，于是把 flex-1 的聊天区挤到 330px、消息视口挤到 **46px**；
                        产品的「首次贴底」恰好在这个状态下执行，宽度落定后视口变 766px、
                        滚动位置丢失，且此时 `scrollable.end=true` ⇒ 模式被判 free-scrolling
                        ⇒ `handleResize` 的贴底守卫不成立 ⇒ 永不恢复（长会话首次进入停在顶部）。
                        限两行 = 保留 task-7 裁定的两行形态，同时让瞬时窄宽不再吃掉高度。
                    -->
                    <div
                        data-testid="session-sandbox-enforcement"
                        role="note"
                        class="line-clamp-2 shrink-0 border-b px-3 py-1 text-xs text-muted-foreground bg-muted/5"
                    >
                        <!-- task-16（自审批01 W-2）：原第二句 sandboxEnforcementSnapshot
                             （「决策快照照冻，仅标注 enforcement=none」）是内部决策快照 / enforcement
                             调试态，不该泄露到用户面 ⇒ 移除内部段，只保留面向用户的安全说明。
                             对应 i18n 键暂留（src/i18n 不在本卡写面），不再被任何 t() 引用。 -->
                        <span class="font-medium text-foreground/80">{{
                            t("workspace.sandboxEnforcement")
                        }}</span>
                    </div>
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
                            class="rounded border border-amber-500/40 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300"
                        >
                            {{ t("workspace.viewerReadOnly") }}
                        </span>
                        <span
                            data-testid="workspace-event-status"
                            class="text-xs"
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
                                data-testid="workspace-usage-cost"
                                :data-cost-source="lastUsage.costSource ?? ''"
                                :data-cost-note="lastUsage.costNote ?? ''"
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
                                data-testid="workspace-usage-source"
                                :data-source="usageSource"
                                class="rounded border px-1 py-0.5 text-xs leading-none"
                                :class="
                                    usageSource === 'real'
                                        ? 'border-emerald-500/40 text-emerald-600'
                                        : 'border-amber-500/40 text-amber-600'
                                "
                            >
                                {{ usageSourceLabel }}
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
                <Select v-model="selectedAgentPrincipalId">
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
