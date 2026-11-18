<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { routeLocationKey, useRouter } from "vue-router";
import { isWorkspaceLessRoute } from "../workspaceLess";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useChatStore } from "../stores/chat.ts";
import { useAgentStore } from "../../../../stores/agent";
import { useAuthStore } from "../../../../stores/auth";
import { useCheckpointStore } from "../../../../stores/checkpoint";
import { useConfigStore } from "../../../../stores/config";
import { useSessionStore } from "../../../../stores/session";
import { useTeamTasksStore } from "../../../../stores/teamTasks";
import {
    ApiError,
    api,
    type ApiFollowUpQueueSnapshot,
    type ApiSessionMessage,
} from "../../../../composables/api";
import { parseRawToParts } from "../composables/useStreamParser.ts";
import { mergeHistoryReasoning, mergeHistoryToolCalls } from "./jobSummaryToolCalls.ts";
import { logger } from "../../../../lib/logger";
import { settingsDomainPath } from "../../../../lib/settingsIa";
import type {
    ApprovalDecisionEnvelope,
    AttachmentFile,
    CheckpointResult,
    Message,
    SessionDerivedActiveChild,
    SessionDerivedStateResponse,
    SessionRunSummary,
    DispatchQueueEntry,
    ToolCallWaitingOn,
} from "../../../../types";
import MessageList from "./MessageList.vue";
import InputArea from "./InputArea.vue";
import SSEStream from "./SSEStream.vue";
import ApprovalModal from "./ApprovalModal.vue";
import SessionSettingsPanel from "./SessionSettingsPanel.vue";
import SessionDerivedStatePanel from "./SessionDerivedStatePanel.vue";
import FollowUpQueuePanel from "./FollowUpQueuePanel.vue";
import TeamBoardPanel from "./TeamBoardPanel.vue";
import GuidancePanel from "./GuidancePanel.vue";
import RevertPreviewDialog from "./RevertPreviewDialog.vue";
import RevertResultDialog from "./RevertResultDialog.vue";
import { useSessionBranches } from "../composables/useSessionBranches";
import { useDerivedAnchors } from "../composables/useDerivedAnchors";
import { chatSessionRoute } from "../sessionRoute";
import { useComposeDeeplink } from "../composables/useComposeDeeplink";
import {
    ensureProviderBinding,
    type ProviderBindingGuideReason,
} from "../composables/ensureProviderBinding";
import ProviderBindingGuideDialog from "./ProviderBindingGuideDialog.vue";
import {
    chatErrorToastText,
    errorCopyKey,
    presentCauseError,
    problemDetailText,
    type ErrorPresentation,
} from "../../../../lib/errorMessages";
import { isTerminalRunStatus, runStateLabelKey } from "../runStateView";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Clock, ShieldAlert } from "@lucide/vue";

const props = withDefaults(
    defineProps<{
        sessionId: string;
        toolMode?: "none" | "workspace";
        /** PLAN-0626 M2: mobile keeps the in-place settings expansion (no dock there). */
        isMobile?: boolean;
    }>(),
    {
        toolMode: "none",
        isMobile: false,
    },
);

const emit = defineEmits<{
    /** PLAN-0626 M2: the chat summary row is the entry to the dock's `context` panel. */
    "open-context-panel": [];
}>();

const { t } = useI18n();
const chatStore = useChatStore(),
    agentStore = useAgentStore(),
    authStore = useAuthStore();
const checkpointStore = useCheckpointStore(),
    configStore = useConfigStore(),
    sessionStore = useSessionStore();
const router = useRouter();
const route = inject(routeLocationKey, null);

/** C1：守卫拦下时暂存这次发送，「自动绑定」成功后原样重发、关闭弹窗时把草稿还给输入框。 */
const pendingProviderBindingSend = ref<
    [string, AttachmentFile[]?, string?, string?, string[]?, string[]?] | null
>(null);

/** C1（2026-11-04 用户裁定）：发送前的 provider 绑定守卫 —— 裸会话不静默失败。 */
const providerBindingGuide = ref<{
    reason: ProviderBindingGuideReason;
    detail: string | null;
} | null>(null);

async function guardProviderBinding(id: string): Promise<boolean> {
    const session = sessionStore.sessions.find((item) => item.id === id);
    // BL-270 (P1): `hasBinding` reads the session row (C1), so a list projection that omits
    // `providerConnectionId` looks unbound even when the session is bound — the send then re-runs
    // bind-defaults and toasts on every message. Warn here (no extra request) so the next projection
    // gap shows up in the console instead of hiding behind a "successful" bind.
    if (!session?.providerConnectionId) {
        logger.warn(
            "session list projection has no providerConnectionId; falling back to bind-defaults",
            { sessionId: id },
        );
    }
    return ensureProviderBinding({
        hasBinding: Boolean(session?.providerConnectionId),
        bindDefaults: () => api.bindSessionDefaults(id),
        onAutoBound: (bound) => {
            sessionStore.applySessionRecord(bound);
            if (bound.modelProvider && bound.modelName) {
                configStore.setSessionModel(
                    id,
                    bound.modelProvider,
                    bound.modelName,
                    bound.providerConnectionId ?? undefined,
                    bound.connectionRevision ?? undefined,
                );
            }
            const label = [bound.modelProvider, bound.modelName].filter(Boolean).join(" · ");
            toast.success(
                label ? `${t("chat.providerAutoBound")} ${label}` : t("chat.providerAutoBound"),
            );
        },
        onGuide: (reason, detail) => {
            providerBindingGuide.value = { reason, detail: detail ?? null };
        },
        onBlocked: (code, detail) => {
            // PLAN-0750 V10 (A1-lite): the principal codes carry an i18n key so this toast follows
            // the active locale (mappedErrorCopy is deliberately hardcoded Chinese — BL-563).
            // Every other code keeps the byte-identical legacy path.
            const key = errorCopyKey(code);
            toast.error(key ? t(key) : chatErrorToastText(code, detail));
        },
    });
}

async function retryProviderBindingGuide(): Promise<void> {
    providerBindingGuide.value = null;
    const bound = await guardProviderBinding(props.sessionId);
    const pending = pendingProviderBindingSend.value;
    pendingProviderBindingSend.value = null;
    // 绑定成功 ⇒ 把刚才被拦下的消息原样发出去（用户点一次「自动绑定」就能继续）。
    if (bound && pending) await handleSend(...pending);
}

function closeProviderBindingGuide(): void {
    providerBindingGuide.value = null;
    const pending = pendingProviderBindingSend.value;
    pendingProviderBindingSend.value = null;
    // 关闭引导 = 放弃本次发送，把草稿还给输入框，不丢用户写的内容。
    if (pending?.[0]) inputComponent.value?.setDraft?.(pending[0]);
}

/**
 * 「去设置」：落**用户层 llm-provider 域页**（连接建在用户层；实例层只提供通往用户层的入口）。
 *
 * 路径必须由 `settingsIa.settingsDomainPath()` 构造 —— 旧实现写的是路由名 `settings-config`，
 * 该 name 在 `6002ea603`（task-253/PLAN-0752 设置区收敛两层）删路由后就不存在了，于是
 * 「去设置」变成**点了没反应的按钮**（task-153 审出、task-154 修）。手写路由名/手写路径
 * 正是它静默失效的机制，别再写回来；路由表变了应当由 helper 跟着变。
 *
 * `await` + `catch` 同样是为了不再静默：旧代码 `void router.push(...)` 把 rejected promise
 * 直接丢弃（`push` 对未知 name 是**同步 throw**，`void` 连 catch 都挂不上），连一行日志都没有。
 */
async function openProviderSettings(): Promise<void> {
    providerBindingGuide.value = null;
    try {
        await router.push(settingsDomainPath("user", "llm-provider"));
    } catch (cause) {
        // 导航失败（守卫抛错/路由表再次漂移）必须留痕，否则下一次同样是"弹窗关了、什么都没发生"。
        logger.error("Failed to open provider settings", cause);
    }
}

const suggestions = computed(() =>
    props.toolMode === "workspace"
        ? ["列出文件", "打开 README", "解释选中的文件", "查看工作区环境"]
        : ["今天天气怎么样？", "帮我写一封邮件", "解释一下这个概念", "总结一下这段代码"],
);

const messages = computed(() => chatStore.getMessages(props.sessionId));

// PLAN-0670 M2d.3：超过 500 条时从最旧端丢弃并累计"已折叠"计数（显式呈现，不静默丢）。
// 丢弃造成的 scrollHeight 变化由 MessageList 的 captureAnchor/restoreAnchor 补偿。
// PLAN-0760：双计数（N=最近段 500 + M=已展开段 ≤1500）。
// 增长来源必须区分：**prepend**（用户主动展开）不得被当成超限丢弃，否则
// prepend 进表的行当帧被丢回，功能净效果为零（BL-556，A/B 实测 Δ≈500px）。
// 首屏裁剪走 loadSessionMessages 的内联 trim（唯一真正的超限来源）。
watch(
    () => messages.value.length,
    (length) => {
        if (length <= MAX_EXPANDED_MESSAGES + MAX_LOADED_MESSAGES) return;
        // prepend 期间不 trim：本次增长正是用户要展开的内容。
        if (loadingOlder.value) return;
        const dropped = chatStore.trimMessages(
            props.sessionId,
            MAX_EXPANDED_MESSAGES + MAX_LOADED_MESSAGES,
        );
        if (dropped > 0) {
            // 丢弃的是**已展开段**（数组最旧端在前部），M 与折叠计数同步回落。
            expandedMessageCount.value = Math.max(0, expandedMessageCount.value - dropped);
            foldedMessageCount.value += dropped;
        }
    },
    { flush: "post" },
);
const isStreaming = computed(() => chatStore.isStreaming(props.sessionId));
// PLAN-0626 M2: the branch projection is shared with the dock's `context` panel (N10:
// one resolver per semantic), so the depth-indented labels no longer live here.
const { selectedBranchId, branchOptions, branchLabels, mainBranchId } = useSessionBranches(
    () => props.sessionId,
);
const followUpQueue = ref<ApiFollowUpQueueSnapshot | null>(null),
    followUpQueueError = ref<string | null>(null);
const followUpQueueSubmitting = ref(false),
    followUpQueueContinuing = ref(false);
const followUpQueueBusyItemId = ref<string | null>(null),
    /**
     * task-125（D-1480-S1）：**每会话一个「上一次排队尝试」槽**，不是「每个签名一个键」。
     *
     * <p>键的语义是「这次尝试可能已经到达 CP，重发必须复用它」—— 它只属于**同一份未改动的草稿的
     * 上一次尝试**。按签名缓存会让「失败 → 用户放弃 → 之后又发同样内容」复用旧键，CP 按幂等键
     * 把新消息当重放（`FollowUpQueueService.enqueue:149-155`，命中即返回旧 snapshot 并
     * `replayed=true`），而前端照常提示「已排队」并清稿 ⇒ **这条消息静默丢失**
     * （缺陷档：task-123 F1；四步见 task-125 卡面）。</p>
     *
     * <p>为什么不给签名加「用户动作代次」：那样连**真重试**也会换键 —— 首次请求其实已落地时
     * 会重复入队，比丢一条更糟（用户被通知两次）。槽 + 寿命才能既保住真重试、又让陈旧键失效。</p>
     */
    pendingFollowUpKey = new Map<string, { signature: string; key: string; at: number }>();
/**
 * task-125 (b)：键的保留窗口。失败分支本身会 `refreshFollowUpQueue`（首次请求其实已落地时
 * 队列会把那条显示出来），所以需要复用键保护的真实重试只发生在**秒级**；超过窗口就按「新动作」处理。
 */
const FOLLOW_UP_KEY_TTL_MS = 60_000;
// task-125 (b)：切会话即清 —— 换回来时旧槽已无意义，也避免按会话累积。
watch(
    () => props.sessionId,
    () => pendingFollowUpKey.clear(),
);
let followUpQueueRequestId = 0,
    followUpQueueSubmitGeneration = 0,
    followUpQueueActionGeneration = 0;
const followUpQueueMode = computed(
    () =>
        isStreaming.value ||
        (followUpQueue.value?.outstandingCount ?? 0) > 0 ||
        followUpQueue.value?.queueState === "paused",
);
const followUpQueueFull = computed(() =>
    Boolean(
        followUpQueue.value &&
        followUpQueue.value.outstandingCount >= followUpQueue.value.capacityLimit,
    ),
);
const derivedState = ref<SessionDerivedStateResponse | null>(null),
    derivedStateLoading = ref(false);
/**
 * PLAN-0659 T1.1：run 分组的数据源（`GET /chat/sessions/{id}/runs` 摘要）。
 * 只在会话切换与 **run 终态**（0645 的终态刷新点）各拉一次，不做轮询。
 */
const sessionRuns = ref<SessionRunSummary[]>([]);
/**
 * task-1 / D-1846：派生态 anchor（子会话状态卡）。投影只用既有读面（会话列表 + 本会话
 * derived-state + 工作区主体名册），**不新增轮询**：derived-state 由既有 SSE 链刷新，
 * anchor 因此就地重绘（key 不变，不产生第二条）。
 */
const { anchors: derivedAnchors, hiddenCount: derivedAnchorsHiddenCount } = useDerivedAnchors({
    sessionId: () => props.sessionId,
    derivedState: () => derivedState.value,
});
const derivedStateError = ref(false),
    waitingOnByToolCallId = ref<Record<string, ToolCallWaitingOn>>({});
let derivedStateRequestId = 0,
    waitingOnRequestId = 0;

const renderedMessages = computed(() =>
    messages.value.map((message) => {
        if (!message.toolCalls?.length) return message;
        return {
            ...message,
            toolCalls: message.toolCalls.map((toolCall) => ({
                ...toolCall,
                waitingOn: waitingOnByToolCallId.value[toolCall.id] ?? null,
            })),
        };
    }),
);

const creatingBranchForMessageId = ref<string | null>(null);
const pendingBranchKeys = new Map<string, string>();
let messageLoadRequestId = 0;

/**
 * PLAN-0670 M2d.1（Lead 2026-11-05 裁定 a）：分页参数可选、CP 未支持时自动退化。
 * 只有响应带 `nextCursor`/`truncated` 才显示「加载更早」；不硬编码假设、不伪造分页。
 */
const MESSAGE_PAGE_SIZE = 50;
const olderCursor = ref<string | null>(null);
const hasOlderMessages = ref(false);
const loadingOlder = ref(false);
const olderExhausted = ref(false);
/** PLAN-0670 M2d.3（Lead 2026-11-05 批准）：最近段内存上限 500；丢弃最旧必须显式折叠。 */
const MAX_LOADED_MESSAGES = 500;
/**
 * PLAN-0760：已展开段上限。与 N 分离 —— N 是内存治理目标（PLAN-0670），
 * M 是用户主动 prepend 的更早段，触顶后停止加载（不静默）。2000 档是 BL-382
 * 已实测过的量级，不引入未知内存风险。
 */
const MAX_EXPANDED_MESSAGES = 1_500;
const expandedMessageCount = ref(0);
const foldedMessageCount = ref(0);

/**
 * PLAN-0665 M2 D5：多路审批**串行**（按 run 创建序逐个弹；首卡显示「1/N 待批」）。
 * store 的 `pendingApprovals` 是 CP 按到达顺序推送的队列，所以这里保留其稳定顺序、只取队首；
 * 不做批量审批（批量语义单独立项）。
 */
const sessionPendingApprovals = computed(() =>
    agentStore.agentState.pendingApprovals.filter(
        (approval) =>
            approval.sessionId === props.sessionId &&
            (approval.state === undefined ||
                approval.state === "pending" ||
                approval.state === "dispatch_unknown"),
    ),
);
const pendingApproval = computed(() => sessionPendingApprovals.value[0] ?? null);
const approvalSubmitting = ref(false),
    approvalError = ref<string | null>(null);
const dismissedRequestIds = ref(new Set<string>());
const showApproval = computed(() => {
    const approval = pendingApproval.value;
    if (!approval) return false;
    if (approval.state === "dispatch_unknown") return true;
    return !dismissedRequestIds.value.has(approval.requestId);
});
/**
 * PLAN-0631 M1-C: a decision that can no longer be taken must not keep asking for one.
 *
 * The reopen pill is a shortcut back into the modal; once the approval's Run has reached a
 * terminal state (cancelled/failed/ambiguous/…, see `isTerminalRunStatus`) the decision is
 * moot, so the pill is retired. The check reads the Run's own assistant message — the same
 * local view the transcript renders — and never guesses: an unknown status is not terminal.
 */
const approvalRunIsTerminal = computed(() => {
    const approval = pendingApproval.value;
    if (!approval) return false;
    return messages.value.some(
        (message) =>
            message.role === "assistant" &&
            message.runId === approval.runId &&
            (isTerminalRunStatus(message.runStatus) ||
                isTerminalRunStatus(message.terminalOutcome)),
    );
});
const showReopenPill = computed(() => {
    const approval = pendingApproval.value;
    return (
        approval !== null &&
        !showApproval.value &&
        dismissedRequestIds.value.has(approval.requestId) &&
        !approvalRunIsTerminal.value
    );
});

/**
 * BL-328：Escape/遮罩关闭审批卡后，焦点必须**回到触发控件**（重开 pill），而不是掉到 `<body>`。
 * 之前只把 requestId 记进 dismissed 集合，键盘用户关掉卡就丢失落点，只能靠 Tab 从头摸回来。
 */
function handleApprovalDismiss() {
    const approval = pendingApproval.value;
    if (!approval) return;
    dismissedRequestIds.value.add(approval.requestId);
    void nextTick(() => reopenPillRef.value?.focus());
}

function reopenApproval() {
    const approval = pendingApproval.value;
    if (!approval) return;
    dismissedRequestIds.value.delete(approval.requestId);
    // 卡片自身在 `show` 变 true 时把焦点放到主操作（ApprovalModal.focusMainAction），这里不抢。
}

// PLAN-0676 T3（BL-333）：另一页/另一个浏览器已经决定了这张审批 —— 本页刚把卡片撤掉，
// 这里补一句可见的解释。否则卡片"凭空消失"会让用户以为是 bug。
watch(
    () => agentStore.approvalResolvedElsewhere,
    (signal) => {
        if (!signal) return;
        toast.info(t("workspace.approvalResolvedElsewhere"));
        agentStore.approvalResolvedElsewhere = null;
    },
);

watch(pendingApproval, (approval, previous) => {
    if (previous && (!approval || approval.requestId !== previous.requestId)) {
        dismissedRequestIds.value.delete(previous.requestId);
    }
    if (approval) {
        void refreshFollowUpQueue(props.sessionId);
    }
});

// ---- task-188 S2/S3（MVP⑤）：TeamBoard 只读板 + steer 来源深链 --------------------------------
// 只读裁定（D-1821）：这里只有挂载/错误文案/两处纯读导航，零写面。

const teamTasksStore = useTeamTasksStore();
teamTasksStore.configure({
    presentError: (cause) => presentCauseError(t, cause, t("teamBoard.errorTitle")).copy,
});
watch(
    () => props.sessionId,
    (id) => teamTasksStore.attach(id),
    { immediate: true },
);
onBeforeUnmount(() => teamTasksStore.detach());

/** 依赖任务跳转：任务是板内资产（非路由对象）⇒ 板内定位并强制展开目标行。 */
const boardHighlightTaskId = ref<string | null>(null);
function onBoardNavigate(taskId: string): void {
    boardHighlightTaskId.value = taskId;
}
async function onBoardRetry(): Promise<void> {
    await teamTasksStore.refresh();
}
/** steer 来源会话跳转：显式导航走 push（深链 /chat/:sessionId 是唯一事实）。 */
async function onFollowUpNavigate(sessionId: string): Promise<void> {
    await router.push(chatSessionRoute(sessionId));
}

// ---- task-188 S3（MVP⑤）：steer 插话入口 ----------------------------------------------------
// 复用既有 composer（InputArea 零改动）：steer 模式下 @send 改道 POST /steers（cp-1 钉形，
// 见 api.steerSession）。面板写面裁定不冲突 —— steer 的写原语就是 CP 的 steer 端点本身，
// UI 只是复用 composer 接住文本，不开第二条写通道。

const steerMode = ref(false);
const steerTargetId = ref<string | null>(null);
const steerSending = ref(false);
const steerError = ref<ErrorPresentation | null>(null);

/** 可插话目标 = 本会话 derived-state 的存活子会话（PLAN-0408 契约，既有读面零新增）。 */
const steerTargets = computed<SessionDerivedActiveChild[]>(
    () => derivedState.value?.activeChildren ?? [],
);
const steerEntryVisible = computed(
    () => steerTargets.value.length > 0 && !steerMode.value && !followUpQueueMode.value,
);

function enterSteerMode(): void {
    steerTargetId.value = steerTargets.value[0]?.childSessionId ?? null;
    steerError.value = null;
    steerMode.value = true;
}

function exitSteerMode(): void {
    steerMode.value = false;
    steerTargetId.value = null;
    steerError.value = null;
}

// 目标从 activeChildren 消失（child 终态被移出投影）⇒ 立即退出，防止把插话发给陈旧目标。
watch(steerTargets, (targets) => {
    if (
        steerMode.value &&
        steerTargetId.value &&
        !targets.some((item) => item.childSessionId === steerTargetId.value)
    ) {
        exitSteerMode();
    }
});
watch(
    () => props.sessionId,
    () => exitSteerMode(),
);

/** 逐码错误面（drawer sectionError 同款模式：码不同、补救不同，一句兜底等于让用户去猜）。 */
function steerErrorPresentation(cause: unknown): ErrorPresentation {
    const presentation = presentCauseError(t, cause, t("steer.errorTitle"));
    const code = cause instanceof ApiError ? cause.problem.code : undefined;
    switch (code) {
        case "STEER_FORBIDDEN":
            return { ...presentation, copy: t("steer.forbidden") };
        case "FOLLOW_UP_NOT_AVAILABLE":
            return { ...presentation, copy: t("steer.unavailable") };
        case "FOLLOW_UP_QUEUE_FULL":
            return { ...presentation, copy: t("steer.queueFull") };
        case "IDEMPOTENCY_KEY_REUSED":
            return { ...presentation, copy: t("steer.keyReused") };
        default:
            return presentation;
    }
}

async function handleSteer(content: string, attachments?: AttachmentFile[]): Promise<void> {
    const target = steerTargetId.value;
    if (!target || steerSending.value) return;
    if (attachments && attachments.length > 0) {
        toast.error(t("steer.attachmentsUnsupported"));
        return;
    }
    steerSending.value = true;
    steerError.value = null;
    try {
        await api.steerSession(target, { text: content }, crypto.randomUUID());
        toast.success(t("steer.sent"));
        exitSteerMode();
    } catch (cause) {
        // 失败留在原地呈现错误面（AlertDialogAction 教训：无条件关弹窗会吞错误）。
        steerError.value = steerErrorPresentation(cause);
    } finally {
        steerSending.value = false;
    }
}
/** Classification authority hint (server still enforces): workspace OWNER / instance ADMIN. */
const canClassifyApproval = computed(() => authStore.canClassifyTools);

/**
 * 历史 DTO → 本地 Message 的唯一映射（首屏/刷新/向上分页共用，避免三份漂移）。
 */
function mapRawMessages(rawMessages: ApiSessionMessage[]): Message[] {
    return rawMessages.map((message) => ({
        id: message.id,
        sessionId: message.sessionId,
        role: message.role.toLowerCase() as Message["role"],
        content: message.content,
        parts:
            message.role.toLowerCase() === "assistant"
                ? // PLAN-0761 (BL-555): reasoning is a separate durable field (V150), not
                  // something the body can carry — parse the text first, then prepend the
                  // persisted thinking block so a refresh replays the same order the live
                  // Run rendered. Absent field (pre-V150 rows) adds nothing.
                  mergeHistoryReasoning(parseRawToParts(message.content), message.reasoning)
                : undefined,
        timestamp: message.createdAt,
        runId: message.runId,
        runStatus: message.runStatus as Message["runStatus"],
        terminalOutcome: message.terminalOutcome as Message["terminalOutcome"],
        errorCode: message.errorCode,
        // PLAN-0492 T3.1: the messages DTO carries the terminal failure text as
        // `errorDetail` (MessageReadService); map it so a history refresh keeps
        // the exhausted-run reason instead of wiping the local error state.
        error: message.errorDetail ?? message.error,
        retryable: message.retryable,
        // PLAN-0344 T1.4 / PLAN-0465 T2.2：刷新后 job 卡片唯一重建源
        //（messages DTO 的 jobSummary ← workspace_jobs 投影）。
        // PLAN-0572：优先用持久化的 toolCalls 快照，并按 toolCallId 与 jobSummary 合并。
        toolCalls: mergeHistoryToolCalls(message.toolCalls, message.jobSummary),
        // PLAN-0572 / BL-555 G3：快照截断态随历史 DTO 回来（CP 只在 truncated=true 时下发）。
        // 渲染侧据此显示「N/M 条调用」；缺失 = 未截断，不渲染提示。
        toolCallsTruncated: message.toolCallsTruncated ?? undefined,
        toolCallsTotal: message.toolCallsTotal ?? undefined,
        // PLAN-0659 T1.3 / PLAN-0669 M1：历史消息的主体归属（可选）。缺失即 undefined ⇒
        // 不渲染 identity 徽标（不猜 PRIMARY、不显示"未知"）；只多一个可选字段，
        // 不影响 delivery 解析与 run 分组。
        participantId: message.participantId ?? undefined,
        // PLAN-0665 M2 / V120：durable 投递语义随历史 DTO 回来；`null` 落成 undefined，
        // 让 `resolveDelivery` 走 legacy 回落而不是把徽标渲染成空行。
        delivery: message.delivery ?? undefined,
        attachments: message.attachments?.map((attachment) => ({
            id: attachment.fileId,
            fileId: attachment.fileId,
            name: attachment.name,
            type: attachment.type,
            size: attachment.size,
            url: `/api/v1/files/${encodeURIComponent(attachment.fileId)}`,
            state: "done" as const,
        })),
    }));
}

async function loadSessionMessages(sessionId: string, requiredMessageIds?: ReadonlySet<string>) {
    const requestId = ++messageLoadRequestId;
    try {
        let branchId = chatStore.getSelectedBranchId(sessionId);
        if (!branchId) {
            await chatStore.loadSessionBranches(sessionId);
            branchId = chatStore.getSelectedBranchId(sessionId);
        }
        if (!branchId) return;
        const rawPage = await api.getMessages(sessionId, branchId, {
            limit: MESSAGE_PAGE_SIZE,
        });
        if (
            props.sessionId !== sessionId ||
            requestId !== messageLoadRequestId ||
            chatStore.getSelectedBranchId(sessionId) !== branchId
        )
            return;
        // 兼容两形态：旧 CP 返回数组（忽略 limit ⇒ 自动退化全量）；新 CP 返回
        // { messages|items, nextCursor, truncated }。
        const rawMessages = Array.isArray(rawPage)
            ? rawPage
            : (rawPage.messages ?? rawPage.items ?? []);
        const pageMeta = Array.isArray(rawPage) ? null : rawPage;
        if (!Array.isArray(rawMessages)) return;
        if (!olderExhausted.value) {
            if (!olderCursor.value) olderCursor.value = pageMeta?.nextCursor ?? null;
            if (pageMeta?.truncated && pageMeta?.nextCursor) hasOlderMessages.value = true;
            else if (pageMeta === null) hasOlderMessages.value = false;
        }
        const loadedMessages = mapRawMessages(rawMessages);
        if (requiredMessageIds && chatStore.isStreaming(sessionId)) {
            for (const message of loadedMessages) {
                if (!requiredMessageIds.has(message.id)) continue;
                const existing = messages.value.find((current) => current.id === message.id);
                if (existing) Object.assign(existing, message);
                else chatStore.addMessage(sessionId, message);
            }
        }
        chatStore.loadMessages(sessionId, loadedMessages);
        // PLAN-0760：首屏是唯一真正的「超限」来源 —— 立即内联裁剪到 N（最近段），
        // 不让 watch 兜底路径处理（否则依赖 flush 时序，且来源语义不清）。
        // 裁剪量计入折叠计数（PLAN-0670 M2d.3：丢弃必须显式呈现，不静默）。
        const dropped = chatStore.trimMessages(sessionId, MAX_LOADED_MESSAGES);
        if (dropped > 0) foldedMessageCount.value += dropped;
        if (derivedState.value?.sessionId === sessionId) {
            void loadWaitingOnProjection(sessionId, derivedState.value.activeChildren);
        }
    } catch (cause) {
        if (cause instanceof ApiError && cause.problem.code === "MESSAGE_NOT_FOUND") return;
        logger.error("Failed to load session messages", cause);
        // BL-288：413 PAGINATION_REQUIRED 的 detail 带条数/上限/建议，不能再静默吞掉。
        toast.error(problemDetailText(cause, t("chat.loadMessagesFailed")));
    }
}

/**
 * PLAN-0670 M2d.1：向上加载更旧一页（`before` 游标由 CP 下发、客户端不解析）。
 * 前插走 store `prependMessages`（去重、保序）；MessageList 的 `captureAnchor/restoreAnchor`
 * 负责把用户正在读的那一行钉回原视觉位置。
 */
async function loadOlderMessages(): Promise<void> {
    const sessionId = props.sessionId;
    const branchId = sessionId ? chatStore.getSelectedBranchId(sessionId) : undefined;
    if (
        !sessionId ||
        !branchId ||
        !hasOlderMessages.value ||
        loadingOlder.value ||
        !olderCursor.value
    ) {
        return;
    }
    const cursor = olderCursor.value;
    loadingOlder.value = true;
    try {
        const page = await api.getMessages(sessionId, branchId, {
            limit: MESSAGE_PAGE_SIZE,
            before: cursor,
        });
        if (props.sessionId !== sessionId) return;
        const rawMessages = Array.isArray(page) ? page : (page.messages ?? page.items ?? []);
        const meta = Array.isArray(page) ? null : page;
        // PLAN-0760：M 触顶后不再发请求。只置 olderExhausted（触发函数开头的守卫），
        // **不动 hasOlderMessages** —— 动它会被 loadSessionMessages 的重置逻辑改回，
        // 形成「点击 → false → 重渲染 → true」的循环（实测 60s 超时）。
        if (expandedMessageCount.value >= MAX_EXPANDED_MESSAGES) {
            olderExhausted.value = true;
            return;
        }
        const restored = chatStore.prependMessages(sessionId, mapRawMessages(rawMessages));
        // M 只增不减（双计数的核心：prepend 进表的行不得再被当超限丢弃）。
        expandedMessageCount.value += restored;
        foldedMessageCount.value = Math.max(0, foldedMessageCount.value - restored);
        olderCursor.value = meta?.nextCursor ?? null;
        hasOlderMessages.value = Boolean(meta?.truncated && meta?.nextCursor);
        if (!hasOlderMessages.value) olderExhausted.value = true;
    } catch (cause) {
        logger.error("Failed to load older messages", cause);
        toast.error(problemDetailText(cause, t("chat.loadOlderFailed")));
    } finally {
        loadingOlder.value = false;
    }
}

// BL-228: 刷新重开（冷启动）时若会话还有在途 run，本页没有它的 SSE —— 终态前历史投影缺
// 在途回复，而 watch(isStreaming) 只管本页发起的 run，列表会永远停在"用户消息"一条
// （goldpath G2-e reload 后 [data-slot=message] 卡 1/2 的根因）。对冷启动做有界追平：
// 只要 listSessionRuns 还有非终态 run，就周期性重拉历史，直到无活动 run 或达到上限。
// loadMessages 在 isStreaming 时早退，不会覆盖本页新发起的 live 流。
/**
 * task-161 / D-1786 面 B（D-1785 最低形态：事实标记 + 跳转）：恢复投放队列的位置。
 *
 * `position` 是 CP 给的队头距离（0 = 队头），本页**不做任何本地推算**——否则 UI 与
 * CP 会各自维护一个顺序，迟早不一致。空队列就是空列表（CP 空队列返回 200 + []），
 * 因此标记的显隐由数据本身决定。
 */
const dispatchQueue = ref<DispatchQueueEntry[]>([]);

async function refreshDispatchQueue(sessionId: string): Promise<void> {
    if (!sessionId) {
        dispatchQueue.value = [];
        return;
    }
    try {
        const response = await api.getSessionDispatchQueue(sessionId);
        if (props.sessionId !== sessionId) return;
        dispatchQueue.value = response.queue ?? [];
    } catch (cause) {
        // 位置是辅助事实：读不到就撤标记，绝不用旧位置继续显示（陈旧位置比没有更误导）。
        if (props.sessionId === sessionId) dispatchQueue.value = [];
        logger.warn("failed to load dispatch queue", cause);
    }
}

/** 跳到该排队 run 的消息/等待卡（消息列表的 run 头带 `data-run-id`）。 */
function jumpToQueuedRun(runId: string): void {
    const target = document.querySelector(`[data-run-id="${runId}"]`);
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "center" });
}

async function refreshSessionRuns(sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
        const response = await api.listSessionRuns(sessionId, { page: 0, size: 100 });
        if (props.sessionId !== sessionId) return;
        sessionRuns.value = response.runs;
    } catch (cause) {
        // 非关键展示数据：失败只记日志，run 头退回 message 自带的 runStatus。
        logger.warn("failed to load session runs", cause);
    }
}

const RUN_CATCHUP_INTERVAL_MS = 1000;
const RUN_CATCHUP_MAX_ATTEMPTS = 30;
const runCatchupTimers = new Map<string, ReturnType<typeof setInterval>>();

function stopRunCatchup(sessionId: string): void {
    const timer = runCatchupTimers.get(sessionId);
    if (timer !== undefined) {
        clearInterval(timer);
        runCatchupTimers.delete(sessionId);
    }
}

function catchUpInFlightRunProjection(sessionId: string): void {
    stopRunCatchup(sessionId);
    let attempts = 0;
    // 首次 tick 只见已终态的会话时不重拉（挂载那次 loadSessionMessages 已是新鲜投影），
    // 避免每次进会话都多打一次 getMessages。
    let sawActiveRun = false;
    const tick = async (): Promise<void> => {
        attempts += 1;
        const exhausted = attempts >= RUN_CATCHUP_MAX_ATTEMPTS;
        try {
            const response = await api.listSessionRuns(sessionId, { page: 0, size: 50 });
            if (props.sessionId !== sessionId) {
                stopRunCatchup(sessionId);
                return;
            }
            const hasActiveRun = response.runs.some((run) => !isTerminalRunStatus(run.status));
            if (hasActiveRun) sawActiveRun = true;
            // PLAN-0659 T1.1：run 摘要（run 头的状态/耗时）由**这个**唯一的会话激活期消费者
            // 落盘；会话切换时不再另发一次 `listSessionRuns`（同一事件两个消费者会让
            // BL-228 的调用次数语义漂移，也是白打一次请求）。
            sessionRuns.value = response.runs;
            // task-161：还有 run 在排队（或本页已知队列非空）⇒ 同轮刷新队列位置。
            // 不新增定时器：排队的 run 本身是非终态，本 tick 会继续跑，直到退役/恢复。
            if (
                dispatchQueue.value.length > 0 ||
                response.runs.some((run) => run.status === "queued")
            ) {
                void refreshDispatchQueue(sessionId);
            }
            if (sawActiveRun) await loadSessionMessages(sessionId);
            if (!hasActiveRun || exhausted) stopRunCatchup(sessionId);
        } catch (cause) {
            logger.warn("run projection catch-up tick failed", cause);
            if (exhausted) stopRunCatchup(sessionId);
        }
    };
    void tick();
    runCatchupTimers.set(
        sessionId,
        setInterval(() => void tick(), RUN_CATCHUP_INTERVAL_MS),
    );
}

/**
 * PLAN-0464 T2.1: the waiting link lives on the child ChatRun row, so the
 * projection reads `GET /chat/sessions/{childSessionId}/runs` once per child
 * session instead of paging Operations and fetching every trace.
 */
async function refreshFollowUpQueue(sessionId: string) {
    const requestId = ++followUpQueueRequestId;
    try {
        const snapshot = await api.getFollowUpQueue(sessionId);
        if (props.sessionId !== sessionId || requestId !== followUpQueueRequestId) return;
        followUpQueue.value = snapshot;
        followUpQueueError.value = null;
        // Admission clears the queue's content copy; reload the owner Message so
        // the queue row can keep showing the prompt after it becomes a ChatRun.
        const missingAdmittedMessages = new Set(
            snapshot.items
                .filter((item) => item.status === "admitted" && item.childMessageId)
                .map((item) => item.childMessageId!)
                .filter((messageId) => {
                    const message = messages.value.find((current) => current.id === messageId);
                    return !message?.content.trim();
                }),
        );
        if (missingAdmittedMessages.size > 0) {
            void loadSessionMessages(sessionId, missingAdmittedMessages);
        }
    } catch (cause) {
        if (props.sessionId !== sessionId || requestId !== followUpQueueRequestId) return;
        // task-45：瞬时面（错误条 + toast）只给可读文案；原始 detail 由下方 logger 留痕。
        followUpQueueError.value = presentCauseError(
            t,
            cause,
            t("chat.followUpQueueLoadFailed"),
        ).copy;
        logger.error("Failed to load Session Follow-up queue", cause);
    }
}

async function loadWaitingOnProjection(
    sessionId: string,
    activeChildren: SessionDerivedStateResponse["activeChildren"],
) {
    const requestId = ++waitingOnRequestId;
    const activeByRunId = new Map(activeChildren.map((child) => [child.runId, child]));
    if (activeByRunId.size === 0) {
        waitingOnByToolCallId.value = {};
        return;
    }

    try {
        const waitingOn: Record<string, ToolCallWaitingOn> = {};
        const childSessionIds = [...new Set(activeChildren.map((child) => child.childSessionId))];
        for (const childSessionId of childSessionIds) {
            const runs = await api.listSessionRuns(childSessionId, { page: 0, size: 200 });
            for (const run of runs.runs) {
                const child = activeByRunId.get(run.runId);
                if (!child || !run.waitingToolCallId) continue;
                waitingOn[run.waitingToolCallId] = {
                    childRunId: child.runId,
                    name: child.name,
                    status: child.status,
                };
            }
        }

        if (props.sessionId === sessionId && requestId === waitingOnRequestId) {
            waitingOnByToolCallId.value = waitingOn;
        }
    } catch (cause) {
        if (props.sessionId === sessionId && requestId === waitingOnRequestId) {
            waitingOnByToolCallId.value = {};
        }
        logger.error("Failed to load durable child wait links", cause);
    }
}

async function refreshDerivedState(sessionId: string) {
    if (!sessionId) return;
    const requestId = ++derivedStateRequestId;
    derivedStateLoading.value = true;
    derivedStateError.value = false;
    try {
        const result = await api.getSessionDerivedState(sessionId);
        if (props.sessionId !== sessionId || requestId !== derivedStateRequestId) return;
        derivedState.value = result;
        const activeRunIds = new Set(result.activeChildren.map((child) => child.runId));
        waitingOnByToolCallId.value = Object.fromEntries(
            Object.entries(waitingOnByToolCallId.value).filter(([, child]) =>
                activeRunIds.has(child.childRunId),
            ),
        );
        await loadWaitingOnProjection(sessionId, result.activeChildren);
    } catch (cause) {
        if (props.sessionId === sessionId && requestId === derivedStateRequestId) {
            derivedStateError.value = true;
            logger.error("Failed to load Session derived state", cause);
        }
    } finally {
        if (props.sessionId === sessionId && requestId === derivedStateRequestId) {
            derivedStateLoading.value = false;
        }
    }
}

function handleDerivedStateRefresh() {
    void refreshDerivedState(props.sessionId);
    guidancePanelRef.value?.refetch();
}

const guidancePanelRef = ref<InstanceType<typeof GuidancePanel> | null>(null);
/** BL-328：Escape 关闭审批卡后的焦点落点（触发控件）。 */
const reopenPillRef = ref<HTMLButtonElement | null>(null);
const currentRunId = computed(() => chatStore.getSessionRunId(props.sessionId));
const currentRunStatus = computed(() => chatStore.getSessionRunState(props.sessionId).status);

/**
 * PLAN-0631 D31-04: CP parks a Run (`status:"queued"`) instead of dispatching it when
 * the Agent is down but the LLM is ready. Nothing executes until recovery, so the
 * view must say so — the previous behaviour was an unexplained stop/queue mode.
 * The copy is a *consequence* of the wire fact; the state itself is never inferred.
 */
const runQueued = computed(() => chatStore.getRunQueued(props.sessionId));
/** Only `agent_down` exists on the wire today; an unknown reason gets the generic hint. */
const QUEUED_REASON_KEYS: Record<string, string> = {
    agent_down: "chat.runState.reasonAgentDown",
};
const runQueuedHint = computed(() => {
    const reason = runQueued.value?.reason;
    return t((reason ? QUEUED_REASON_KEYS[reason] : undefined) ?? "chat.runState.queuedHint");
});

/**
 * PLAN-0631 D31-03/D31-01: the waiting-for-approval wording comes from the single
 * `runStateView` resolver, so the in-stream status row and the composer pill can never
 * drift into two different sentences ("等待审批" vs "等待确认"). Both surfaces read the
 * same `pendingApproval` computed; only the wording source is shared with the resolver.
 */
const approvalWaitingLabel = computed(() => {
    const key = runStateLabelKey("awaiting_approval");
    return key ? t(key) : t("chat.runState.awaitingApproval");
});
/** A failed/uncertain recovery needs alert semantics; a plain "resumed" is a status. */
const recoveryBannerRole = computed(() =>
    runRecovery.value?.state === "failed" ? "alert" : "status",
);

// Keep the last run so its Guidance list remains readable after the run goes terminal;
// only the input is gated by the active status.
const lastRunId = ref<string | undefined>(undefined);
watch(
    [currentRunId, () => props.sessionId],
    ([runId]) => {
        if (runId) lastRunId.value = runId;
    },
    { immediate: true },
);

const streamComponent = ref<InstanceType<typeof SSEStream> | null>(null);
const inputComponent = ref<InstanceType<typeof InputArea> | null>(null);

/**
 * BL-339：外部入口用 `?compose=<base64url(JSON)>` 把「要发的内容 + 目标主体」带进来。
 * 只预填 composer（正文 + 空位的 to/cc），**绝不代发**；预填成功后本组件让 composable
 * 用 `router.replace` 抹掉参数，刷新或后退都不会重复预填。
 */
useComposeDeeplink({
    sessionId: () => props.sessionId,
    ready: () => Boolean(inputComponent.value?.prefillDraft),
    // A 步：名册到达（null → 已加载）后重试一次 —— 不能靠定时器，也不能把 ready 抬成
    // 「名册必须已加载」（名册永不返回时会连正文都不预填）。
    retryKey: () => inputComponent.value?.recipientsReady ?? false,
    // 三态语义（task-113 B 步改）：**只有 `applied` 算已消费**。
    // 旧实现把 `idle` 也算已消费，而 `idle` 恰好覆盖「名册还没回来 ⇒ to/cc 被过滤一空」这个情形
    // ⇒ 清参走的是 `replace`，收件人**永久不可恢复**（task-111 定位；第 0 步用例红的正是这里）。
    // 现在 `idle` 与未就绪都保留参数：地址栏里留着 `?compose=` 就是「尚未消费」的可见标记，
    // 后续（A 步）由「名册到达后重试」来消费它。
    apply: (payload) => {
        const result = inputComponent.value?.prefillDraft?.({
            text: payload.text,
            to: payload.to,
            cc: payload.cc,
        });
        // task-126 F3：`blocked_unsat` 也要**消费**参数 —— 它不可满足（id 不在本会话名册），
        // 留着只会让 URL 永久带 `?compose=`、每次重试刷 warn。用户可见提示由 InputArea 自己渲染
        // （`compose-deeplink-unsat-hint`），所以这里只负责"已消费"这一件事。
        return result === "applied" || result === "blocked_unsat";
    },
});

/**
 * PLAN-0623：把「提及」转交给输入框（`@displayName` 插入草稿，不发送）。
 * 由 WorkspaceView 通过 ref 调用，dock 里的参与者面板不直接持有 composer。
 */
function insertMention(name: string): void {
    inputComponent.value?.insertMention?.(name);
}

defineExpose({ insertMention });
let previousSessionId: string | null = null;

watch(
    () => props.sessionId,
    (sessionId) => {
        messageLoadRequestId += 1;
        olderCursor.value = null;
        hasOlderMessages.value = false;
        loadingOlder.value = false;
        olderExhausted.value = false;
        expandedMessageCount.value = 0;
        foldedMessageCount.value = 0;
        derivedStateRequestId += 1;
        waitingOnRequestId += 1;
        creatingBranchForMessageId.value = null;
        derivedState.value = null;
        derivedStateError.value = false;
        derivedStateLoading.value = Boolean(sessionId);
        waitingOnByToolCallId.value = {};
        followUpQueueRequestId += 1;
        followUpQueueSubmitGeneration += 1;
        followUpQueueActionGeneration += 1;
        followUpQueue.value = null;
        followUpQueueError.value = null;
        followUpQueueSubmitting.value = false;
        followUpQueueContinuing.value = false;
        followUpQueueBusyItemId.value = null;
        if (previousSessionId && previousSessionId !== sessionId) {
            stopRunCatchup(previousSessionId);
            sessionRuns.value = [];
            chatStore.detachLiveSession(previousSessionId);
            lastRunId.value = undefined;
        }
        previousSessionId = sessionId;
        if (sessionId) {
            void loadSessionMessages(sessionId);
            void refreshDerivedState(sessionId);
            void refreshFollowUpQueue(sessionId);
            // run 摘要不在这里单独拉：`catchUpInFlightRunProjection` 的首个 tick 就是一次
            // `listSessionRuns`，并在拿到结果时写 `sessionRuns`（同一会话激活期只打一次）。
            catchUpInFlightRunProjection(sessionId);
        }
    },
    { immediate: true },
);

onBeforeUnmount(() => {
    // 删除当前项对 Map 迭代安全（与 chatStore 的 Set 迭代注释同理）。
    for (const id of runCatchupTimers.keys()) stopRunCatchup(id);
});

watch(selectedBranchId, (branchId, previousBranchId) => {
    if (branchId && branchId !== previousBranchId && props.sessionId) {
        void loadSessionMessages(props.sessionId);
    }
});

watch(isStreaming, (streaming, previous) => {
    if (streaming !== previous && props.sessionId) {
        if (previous && !streaming) {
            void loadSessionMessages(props.sessionId);
            // 追平循环在跑时它每个 tick 都会写 `sessionRuns`，终态点不再重复拉一次
            // （同一 run 的终态只留一个消费者）；没有循环时才由这里刷新。
            if (!runCatchupTimers.has(props.sessionId)) void refreshSessionRuns(props.sessionId);
            guidancePanelRef.value?.refetch();
        }
        void refreshFollowUpQueue(props.sessionId);
    }
});

async function handleSend(
    content: string,
    attachments?: AttachmentFile[],
    branchIdOverride?: string,
    speakAsParticipantId?: string,
    /** PLAN-0630 M5b (D30-14)：composer 的 cc 旁听名单（participantId 数组）。 */
    cc?: string[],
    /** PLAN-0665 M2（D4）：composer 的 TO 目标集合（participantId 数组，1..N 个 AGENT）。 */
    toParticipantIds?: string[],
) {
    const id = props.sessionId;
    if (!id) return;
    if (isStreaming.value) return;
    // C1：未绑定的会话先补绑/引导，绝不把消息发出去撞 409 PROVIDER_REQUIRED。
    if (!(await guardProviderBinding(id))) {
        pendingProviderBindingSend.value = [
            content,
            attachments,
            branchIdOverride,
            speakAsParticipantId,
            cc,
            toParticipantIds,
        ];
        return;
    }
    let branchId: string | undefined = branchIdOverride ?? selectedBranchId.value;
    if (!branchId) {
        try {
            await chatStore.loadSessionBranches(id);
            branchId = branchIdOverride ?? chatStore.getSelectedBranchId(id);
        } catch (cause) {
            logger.error("Failed to load branch selector before Chat submission", cause);
            toast.error(t("chat.branchLoadFailed"));
            return;
        }
    }
    if (!branchId) {
        toast.error(t("chat.branchLoadFailed"));
        return;
    }

    await submitMessage({
        content,
        attachments,
        branchId,
        asParticipantId: speakAsParticipantId,
        cc,
        toParticipantIds,
    });
}

/**
 * task-129：`draftRevision` 由 composer 随 emit 上行，用来区分「同一份稿」与「改过又改回」。
 * 它是**第 6 个**参数，前 5 个的语义未动。
 */
async function handleFollowUpQueue(
    content: string,
    attachments?: AttachmentFile[],
    // 入队路径今天不带 as / cc / to（那是 task-49 的另一条链路），但**位置必须占住**：
    // draftRevision 是 emit 的第 6 个实参，参数表错位一位就会静默拿到 undefined（已踩）。
    _asParticipantId?: string,
    _cc?: string[],
    _toParticipantIds?: string[],
    draftRevision?: number,
) {
    const sessionId = props.sessionId;
    if (
        !sessionId ||
        followUpQueueSubmitting.value ||
        followUpQueueFull.value ||
        followUpQueueBusyItemId.value ||
        followUpQueueContinuing.value
    )
        return;
    // C1：入队同样先补绑 —— 否则只是把 409 推迟到 run 派发时。
    if (!(await guardProviderBinding(sessionId))) return;
    let branchId = selectedBranchId.value;
    if (!branchId) {
        try {
            await chatStore.loadSessionBranches(sessionId);
            branchId = chatStore.getSelectedBranchId(sessionId) ?? "";
        } catch (cause) {
            logger.error("Failed to load branch selector before Follow-up enqueue", cause);
            toast.error(t("chat.branchLoadFailed"));
            return;
        }
    }
    if (props.sessionId !== sessionId) return;
    if (!branchId) {
        toast.error(t("chat.branchLoadFailed"));
        return;
    }

    const fileIds = (attachments ?? [])
        .map((attachment) => attachment.fileId)
        .filter((fileId): fileId is string => Boolean(fileId));
    const binding = configStore.getEffectiveModel(sessionId);
    const signature = JSON.stringify([
        branchId,
        content,
        // task-129：稿代次进签名 ⇒ 「改稿 → 改回」也是新签名 ⇒ 不复用旧键；
        // 未改稿重发 ⇒ 同一代次 ⇒ 仍复用（真重试语义不变）。
        draftRevision ?? 0,
        fileIds,
        props.toolMode,
        binding?.provider ?? null,
        binding?.model ?? null,
    ]);
    // task-125：只有在「同一份草稿 + 还在保留窗口内」时才复用键（= 真重试）；否则是新动作。
    const previousAttempt = pendingFollowUpKey.get(sessionId);
    const reuseKey =
        previousAttempt !== undefined &&
        previousAttempt.signature === signature &&
        Date.now() - previousAttempt.at < FOLLOW_UP_KEY_TTL_MS;
    const idempotencyKey = reuseKey ? previousAttempt.key : crypto.randomUUID();
    pendingFollowUpKey.set(sessionId, { signature, key: idempotencyKey, at: Date.now() });
    const requestGeneration = ++followUpQueueSubmitGeneration;

    followUpQueueSubmitting.value = true;
    followUpQueueError.value = null;
    try {
        const { snapshot, replayed } = await api.enqueueFollowUpDetailed(
            sessionId,
            {
                content,
                ...(fileIds.length > 0 ? { attachments: fileIds } : {}),
                branchId,
                toolMode: props.toolMode,
                ...(binding?.provider ? { provider: binding.provider } : {}),
                ...(binding?.model ? { model: binding.model } : {}),
            },
            idempotencyKey,
        );
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueSubmitGeneration)
            return;
        followUpQueue.value = snapshot;
        followUpQueueError.value = null;
        // 成功（含 CP 的 replayed 重放）即消费该槽：下一次同内容是新动作。
        if (pendingFollowUpKey.get(sessionId)?.key === idempotencyKey) {
            pendingFollowUpKey.delete(sessionId);
        }
        if (replayed) {
            // task-125 (c′)：CP 用 200 表示「命中既有幂等键」，这一条**没有新建**。
            // 不能报「已排队」：用户会以为自己发了两条；也不能清稿：这条内容并没有被入队，
            // 清掉等于替用户丢掉它。
            toast.info(t("chat.followUpAlreadyQueued"));
        } else {
            inputComponent.value?.clearDraft?.();
            toast.success(t("chat.followUpQueued"));
        }
        void refreshFollowUpQueue(sessionId);
    } catch (cause) {
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueSubmitGeneration)
            return;
        // task-45：可读文案进错误条 + toast，原始 detail 只进日志（瞬时面不塞折叠控件）。
        const message = presentCauseError(t, cause, t("chat.followUpQueueFailed")).copy;
        followUpQueueError.value = message;
        logger.error("Failed to enqueue Session Follow-up", cause);
        toast.error(message);
        void refreshFollowUpQueue(sessionId);
    } finally {
        if (requestGeneration === followUpQueueSubmitGeneration) {
            followUpQueueSubmitting.value = false;
        }
    }
}

async function withdrawFollowUp(queueItemId: string) {
    const sessionId = props.sessionId;
    if (!sessionId || followUpQueueBusyItemId.value || followUpQueueContinuing.value) return;
    const requestGeneration = ++followUpQueueActionGeneration;
    followUpQueueBusyItemId.value = queueItemId;
    followUpQueueError.value = null;
    try {
        const snapshot = await api.withdrawFollowUp(sessionId, queueItemId);
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration)
            return;
        followUpQueue.value = snapshot;
        toast.success(t("chat.followUpWithdrawn"));
    } catch (cause) {
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration)
            return;
        // task-45：可读文案进错误条 + toast，原始 detail 只进日志（瞬时面不塞折叠控件）。
        const message = presentCauseError(t, cause, t("chat.followUpQueueFailed")).copy;
        followUpQueueError.value = message;
        logger.error("Failed to withdraw Session Follow-up", cause);
        toast.error(message);
    } finally {
        if (requestGeneration === followUpQueueActionGeneration)
            followUpQueueBusyItemId.value = null;
    }
}

async function continueFollowUpQueue() {
    const sessionId = props.sessionId;
    if (!sessionId || followUpQueueContinuing.value || followUpQueueBusyItemId.value) return;
    const requestGeneration = ++followUpQueueActionGeneration;
    followUpQueueContinuing.value = true;
    followUpQueueError.value = null;
    try {
        const snapshot = await api.continueFollowUpQueue(sessionId);
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration)
            return;
        followUpQueue.value = snapshot;
        toast.success(t("chat.followUpContinued"));
        void refreshFollowUpQueue(sessionId);
    } catch (cause) {
        if (props.sessionId !== sessionId || requestGeneration !== followUpQueueActionGeneration)
            return;
        // task-45：可读文案进错误条 + toast，原始 detail 只进日志（瞬时面不塞折叠控件）。
        const message = presentCauseError(t, cause, t("chat.followUpQueueFailed")).copy;
        followUpQueueError.value = message;
        logger.error("Failed to continue Session Follow-up queue", cause);
        toast.error(message);
    } finally {
        if (requestGeneration === followUpQueueActionGeneration)
            followUpQueueContinuing.value = false;
    }
}

/**
 * 输入框的 `send` 事件现在带第三个参数（`asParticipantId`，D23-27 代发 / M5b to）与第四个参数
 * （`cc`，M5b 旁听名单）。`handleSend` 的第三个位置是 `branchIdOverride`（队列流程在用），
 * 所以这里显式转接，避免"代发 id 被当成 branchId"这种静默错位。
 */
function onInputSend(
    content: string,
    attachments?: AttachmentFile[],
    asParticipantId?: string,
    cc?: string[],
    toParticipantIds?: string[],
): Promise<void> {
    // task-188 S3：steer 模式下 composer 的 send 改道插话（composer 复用，仅去向不同）。
    if (steerMode.value) return handleSteer(content, attachments);
    return handleSend(content, attachments, undefined, asParticipantId, cc, toParticipantIds);
}

/**
 * task-29（D-1866 后续）：首条消息发出后把该会话**重读一次**。
 *
 * <p>事实：CP 在首条 user-facing 消息落库的**同一事务、同一 Session 行锁内**把默认标题改成
 * 规则派生标题（`0cc9fb449`，`SessionTitleDeriver.applyToFirstMessage`）⇒ `POST /chat` 返回 202
 * 时新标题已经 durable。但仓库里**没有 session-updated SSE 事件**，`POST /chat` 响应也**不带标题**
 * （把标题塞进响应要动 OpenAPI 契约面，按 `xc-cross-cutting-checklist` 评估后裁定不做）⇒
 * 侧栏要刷新页面或切会话才看到新名字。标题是已 durable 的事实，UI 只欠一次重读：
 * `loadSession` → `applySessionRecord` → `upsertSession` 原地替换 live 投影，侧栏当帧更新，
 * **不整页刷新**。</p>
 *
 * <p>为什么按「首条」而不是每条：每条消息都重读等于每次对话多拉一遍会话投影（判据 3）。
 * 判据在**发送之前**取 `messages.length === 0` —— 发送成功后本地已经有这条乐观消息了。
 * `Set` 是第二道闸：历史加载失败的老会话不会被误判成首条并反复重读。</p>
 *
 * <p>失败只留痕、不弹错：标题在 durable 侧已经改好，下一次列表刷新（切会话 / 手动改名）照样带上，
 * 一次 cosmetic 重读失败不值得打断用户 —— 也不重试，因为重试的判据（`hadNoMessages`）在乐观消息
 * 入表后就不成立了，硬留一个撤销分支只会变成没人走的代码路。</p>
 */
const sessionRereadsAfterFirstMessage = new Set<string>();

function rereadSessionAfterFirstMessage(sessionId: string, hadNoMessages: boolean): void {
    if (!hadNoMessages || sessionRereadsAfterFirstMessage.has(sessionId)) return;
    sessionRereadsAfterFirstMessage.add(sessionId);
    void sessionStore.loadSession(sessionId).catch((cause: unknown) => {
        logger.warn("Re-reading the session after its first message failed", {
            sessionId,
            cause,
        });
    });
}

async function submitMessage(input: {
    content: string;
    attachments?: AttachmentFile[];
    branchId: string;
    /** D23-27：以某个参与者身份发言（"代发"）。仅当 `capabilities.speakAs` 为真时才会有值。 */
    asParticipantId?: string;
    /** PLAN-0630 M5b (D30-14)：composer 的 cc 旁听名单（participantId 数组，随消息发送）。 */
    cc?: string[];
    /** PLAN-0665 M2（D4）：TO 目标集合；每个目标各自起 run。 */
    toParticipantIds?: string[];
}) {
    let { content, attachments, branchId, asParticipantId, cc, toParticipantIds } = input;
    if (!authStore.canWriteWorkspace) {
        toast.error(t("workspace.viewerReadOnly"));
        return;
    }
    /*
     * task-547 F-A（第二道闸）：独立会话（无工作区）发送前的**兜底剥离**。
     *
     * <p>历史：CP 曾对 TO/CC/代发/附件任一非空直接 400 `WORKSPACE_LESS_FEATURE_FORBIDDEN`，
     * 所以这里按**路由**（不是错误码）统一剥掉四项。**task-49（D-1436/D-1438 后）已放开三项**：
     * 独立会话可以发送给成员（TO）、抄送（CC）与代发（as）—— 预剥离留着它们才是缺陷：
     * CP 已经有能力，UI 却在这里静默丢字段，用户面前零效果（`cp-1` 的对照表就是这么查出本函数的）。</p>
     *
     * <p>**附件仍然剥**（`D-1436` 裁定 3：独立会话附件仍 400）。这一项保留原语义：剥掉并**说出来**，
     * 不静默改写用户的请求内容。队列重放 / 键盘快捷路径 / 旧草稿都可能带着附件到这里。</p>
     */
    if (isWorkspaceLessRoute(route)) {
        const dropped = { attachments: (attachments ?? []).length };
        if (dropped.attachments > 0) {
            logger.warn("[task-49] workspace-less Session 不支持附件，已丢弃", dropped);
            toast.warning(t("chat.input.workspaceLessDropped"));
            attachments = undefined;
        }
    }
    const id = props.sessionId;
    // task-29：首条消息的判据必须在发送**之前**取（发送后乐观消息已入表）。
    const hadNoMessages = messages.value.length === 0;

    const fileIds = attachments
        ?.map((a) => a.fileId)
        .filter((fileId): fileId is string => fileId !== undefined);
    const result = await streamComponent.value?.sendMessage(content, {
        branchId,
        attachments: fileIds,
        toolMode: props.toolMode,
        asParticipantId,
        cc,
        toParticipantIds,
    });
    if (!result) return;

    // Keep this run's client-side transcript through the post-terminal history refresh: the
    // durable message projection can lag the terminal SSE event (see chat store
    // `unprojectedRuns`), and replacing the transcript in that window silently dropped the
    // user's prompt, the streamed tokens, and the error box. `adoptRunId` also binds the run
    // id to a live reply whose first token beat this `202` body.
    chatStore.adoptRunId(id, result.runId);

    const userMessageId = result.messageId ?? crypto.randomUUID();
    chatStore.markClientOwned(id, userMessageId);
    chatStore.addMessage(id, {
        id: userMessageId,
        sessionId: id,
        role: "user",
        content,
        timestamp: new Date().toISOString(),
        branchId,
        attachments,
        runId: result.runId,
        runStatus: result.status,
        // PLAN-0631 D31-08: a `speakAs` message is attributed to the participant whose
        // identity the caller chose (CP validates it). Absent = the caller's own words.
        ...(asParticipantId ? { participantId: asParticipantId } : {}),
        // PLAN-0659 T1.3：投递语义（发送/抄送）由 composer 这一层产出，**乐观本地视图**；
        // PLAN-0665 M2 / V120 起已 durable（`messages.delivery` jsonb，BL-239 已关账）——
        // 刷新后不再消失。不落 localStorage、不进 wire（本 PLAN 非目标）。
        // PLAN-0665 M2 / V120：乐观消息直接写 **durable 形状**（`{to[], cc[]}`），
        // 这样刷新回来的 durable `messages.delivery` 与本地是同一形状、同一渲染路径；
        // legacy 形状只作为旧消息的回落（见 `resolveDelivery`）。
        ...(toParticipantIds?.length || (cc?.length ?? 0) > 0
            ? { delivery: { to: toParticipantIds ?? [], cc: cc ?? [] } }
            : {}),
    });
    inputComponent.value?.clearDraft();
    // task-29：首条消息落库即命名（D-1866）⇒ 这一次重读把新标题带回侧栏，不刷页面、不切会话。
    rereadSessionAfterFirstMessage(id, hadNoMessages);
}

async function handleRetry(messageId: string) {
    const index = messages.value.findIndex((message) => message.id === messageId);
    if (index < 0) return;
    let userMessage: Message | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (messages.value[cursor]?.role === "user") {
            userMessage = messages.value[cursor];
            break;
        }
    }
    if (!userMessage) return;
    await handleSend(userMessage.content, userMessage.attachments, userMessage.branchId);
}

async function handleCreateBranch(anchorMessageId: string) {
    const sessionId = props.sessionId,
        sourceBranchId = selectedBranchId.value;
    if (!sessionId || !sourceBranchId || isStreaming.value || creatingBranchForMessageId.value)
        return;

    const keyScope = `${sessionId}:${sourceBranchId}:${anchorMessageId}`;
    const idempotencyKey = pendingBranchKeys.get(keyScope) ?? crypto.randomUUID();
    pendingBranchKeys.set(keyScope, idempotencyKey);
    creatingBranchForMessageId.value = anchorMessageId;
    try {
        const created = await api.createSessionBranch(
            sessionId,
            { sourceBranchId, anchorMessageId },
            idempotencyKey,
        );
        if (props.sessionId !== sessionId) return;
        await chatStore.loadSessionBranches(sessionId);
        chatStore.selectBranch(sessionId, created.branchId);
        pendingBranchKeys.delete(keyScope);
        toast.success(t("chat.branchCreated"));
    } catch (cause) {
        const message = presentCauseError(t, cause, t("chat.branchCreateFailed")).copy;
        logger.error("Failed to create Session branch", cause);
        toast.error(message);
    } finally {
        if (props.sessionId === sessionId) creatingBranchForMessageId.value = null;
    }
}

async function handleDeleteMessage(messageId: string) {
    try {
        await api.deleteMessage(props.sessionId, messageId);
        chatStore.deleteMessage(props.sessionId, messageId);
    } catch (err) {
        logger.error("Failed to delete message", err);
    }
}

function approveTool(toolId: string) {
    agentStore.approveTool(toolId);
}

function rejectTool(toolId: string) {
    agentStore.rejectTool(toolId);
}

async function decideApproval(submission: ApprovalDecisionEnvelope) {
    const approval = pendingApproval.value;
    if (!approval || approvalSubmitting.value) return;
    // Drop a stale continuation: a classification write can resolve after the pending request
    // changed, and only the currently actionable request may be decided.
    if (submission.requestId !== approval.requestId) return;

    approvalSubmitting.value = true;
    approvalError.value = null;
    try {
        const { decision, feedback, layer, rule } = submission;
        const response = await agentStore.decideApproval(approval.requestId, {
            decision,
            ...(feedback === undefined ? {} : { feedback }),
            ...(layer === undefined ? {} : { layer }),
            ...(rule === undefined ? {} : { rule }),
        });
        if (response.status === "queued") {
            // task-161：决定已作出、等执行槽——不是 accepted（那表示已执行并唤醒 Agent）。
            // 立刻取一次位置让标记出现；后续位置由 run 追平 tick 每轮刷新。
            // 卡片收起：这一单已经落定在「等执行」，继续挂着只会引诱用户再点一次（那是 409）。
            dismissedRequestIds.value.add(approval.requestId);
            await refreshDispatchQueue(approval.sessionId);
        } else if (response.status === "accepted" || response.status === "already_decided") {
            chatStore.invalidateRunRecovery(approval.sessionId, approval.runId);
            if (dispatchQueue.value.length > 0) await refreshDispatchQueue(approval.sessionId);
        }
    } catch (err) {
        // task-45：兜底从英文硬编码改为本地化文案（这一处原本会漏出英文）。
        const message = presentCauseError(t, err, t("errors.requestFailed")).copy;
        if (err instanceof ApiError && err.problem.code === "APPROVAL_EXPIRED") {
            // PLAN-0663 M2/T2.1: the store already retired the expired request (terminal state), so
            // the modal is gone — explain it with a NON-modal notice instead of leaving a dead
            // approval on screen. Reused `vue-sonner`; no second feedback surface is introduced.
            toast.error(t("chat.approvalExpiredNotice"));
        } else {
            approvalError.value = message;
        }
        logger.error("Failed to submit chat approval decision", err);
    } finally {
        approvalSubmitting.value = false;
    }
}

function stopStreaming() {
    streamComponent.value?.stopStreaming?.();
}

// ── PLAN-292 M3 (C3): run recovery banner ────────────────────────────────
// A dead SSE or a page refresh hides what the run is doing. On mount, ask
// the CP for the last run's status and surface one of three honest states.
const runRecovery = computed(() => chatStore.runRecovery[props.sessionId] ?? null);

watch(
    runRecovery,
    (recovery) => {
        if (recovery && guidancePanelRef.value) {
            void guidancePanelRef.value.refetch();
        }
    },
    { immediate: true },
);

function recoverableRunId(): string | null {
    const msgs = chatStore.getMessages(props.sessionId);
    for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i];
        if (msg.role === "assistant" && msg.runId && msg.runStatus !== "succeeded") {
            return msg.runId;
        }
    }
    return null;
}

onMounted(() => {
    const runId = recoverableRunId();
    if (runId) void chatStore.refreshRunRecovery(props.sessionId, runId);
});

const recoveryBannerClass = computed(() => {
    switch (runRecovery.value?.state) {
        case "resumed":
            return "border-primary/40 bg-primary/10 text-foreground";
        case "cancelled":
            return "border-border bg-muted/40 text-muted-foreground";
        default:
            return "border-destructive/40 bg-destructive/10 text-foreground";
    }
});

// ── PLAN-0339: workspace slice restore flow (preview → execute → result) ────
// The entry lives beside the message; the dialogs are hosted here so
// every chat surface (chat view, workspace chat, mobile sheet) gets the same flow.
const revertPreviewSliceRef = ref<string | null>(null),
    revertBusy = ref(false),
    revertError = ref<string | null>(null);
const revertResult = ref<CheckpointResult | null>(null);

function openRevertPreview(sliceRef: string) {
    revertResult.value = null;
    revertError.value = null;
    revertPreviewSliceRef.value = sliceRef;
}

function closeRevertPreview() {
    if (revertBusy.value) return;
    revertPreviewSliceRef.value = null;
    revertError.value = null;
}

async function confirmRevert(
    acknowledgeTypeChanges: string[],
    acknowledgeNestedRepos: string[] = [],
    force = false,
) {
    const sliceRef = revertPreviewSliceRef.value,
        sessionId = props.sessionId;
    const workspaceId = authStore.currentWorkspaceId;
    if (!sliceRef || !workspaceId || revertBusy.value) return;
    revertBusy.value = true;
    revertError.value = null;
    try {
        const result = await api.executeWorkspaceCheckpointRevert(
            workspaceId,
            sliceRef,
            acknowledgeTypeChanges,
            acknowledgeNestedRepos,
            force,
        );
        // A session switch while the request was in flight drops the continuation: the result
        // dialog must not open over a different session.
        if (props.sessionId !== sessionId || authStore.currentWorkspaceId !== workspaceId) return;
        // Refresh the durable workspace projection after the result is shown.
        void checkpointStore.fetchWorkspaceCheckpoints(workspaceId, { force: true });
        revertPreviewSliceRef.value = null;
        revertResult.value = result;
        const counts = result.counts;
        if (counts && counts.failed > 0) {
            toast.warning(t("chat.checkpointRevertPartial"));
        } else {
            toast.success(t("chat.checkpointRevertDone"));
        }
    } catch (cause) {
        if (props.sessionId !== sessionId || authStore.currentWorkspaceId !== workspaceId) return;
        revertError.value = presentCauseError(t, cause, t("chat.checkpointRevertFailed")).copy;
        logger.warn("Failed to execute workspace checkpoint restore", cause);
    } finally {
        revertBusy.value = false;
    }
}

function retryRevert(sliceRef: string) {
    revertResult.value = null;
    revertError.value = null;
    revertPreviewSliceRef.value = sliceRef;
}

function closeRevertResult() {
    revertResult.value = null;
}

watch(
    () => props.sessionId,
    () => {
        revertPreviewSliceRef.value = null;
        revertResult.value = null;
        revertError.value = null;
        revertBusy.value = false;
    },
);
</script>

<template>
    <!-- `flex-1` takes the height left by the session head / banners instead of a hard
         `h-full` of the column: the panel sits in a flex column with a 32px title row above
         (`h-8` since D-1842 put `--spacing` back to the Tailwind default 4px; it was 31.5px
         under the old 3.5px grid and "36px" in older comments was the nominal value),
         it, so 100% would overflow the column by exactly that row and push the composer (and
         the dock's bottom edge) below the fold. `h-full` stays for hosts where the panel is
         the only child and the parent is not a flex container.
         PLAN-0702 / BL-327: the mobile panel no longer scrolls as a whole — MessageList owns
         the scroll. Otherwise the composer (the bottom control) leaves the visual viewport when
         the on-screen keyboard shrinks it, which is exactly the safe-area regression this plan
         fixes. -->
    <div class="flex flex-col h-full min-h-0 flex-1 overflow-hidden">
        <SessionSettingsPanel
            :session-id="sessionId"
            :is-mobile="isMobile"
            :branch-options="branchOptions"
            :selected-branch-id="selectedBranchId"
            :main-branch-id="mainBranchId"
            @open-context-panel="emit('open-context-panel')"
        />

        <div
            v-if="runRecovery"
            data-testid="run-recovery-banner"
            class="flex items-center justify-between gap-3 mx-4 mt-3 px-3 py-2 rounded-lg border text-sm"
            :class="recoveryBannerClass"
            :role="recoveryBannerRole"
        >
            <span>{{ runRecovery.message }}</span>
            <button
                class="px-2 py-0.5 text-xs rounded border border-border hover:bg-accent shrink-0"
                data-testid="run-recovery-dismiss"
                @click="chatStore.dismissRunRecovery(props.sessionId)"
            >
                知道了
            </button>
        </div>

        <SessionDerivedStatePanel
            :active-children="derivedState?.activeChildren ?? []"
            :terminal-notices="derivedState?.terminalNotices ?? []"
            :loading="derivedStateLoading"
            :error="derivedStateError"
            @retry="handleDerivedStateRefresh"
        />

        <!-- PLAN-0631 D31-04: parked Run — say what is happening instead of a silent spinner. -->
        <Marker
            v-if="runQueued"
            data-testid="chat-run-queued"
            role="status"
            aria-live="polite"
            class="mx-4 mt-2 rounded-lg border border-border bg-card px-3 py-2"
        >
            <MarkerIcon>
                <Clock class="size-3.5" aria-hidden="true" />
            </MarkerIcon>
            <MarkerContent>
                <span class="font-medium text-foreground">{{ t("chat.runState.queued") }}</span>
                <span class="ml-2">{{ runQueuedHint }}</span>
            </MarkerContent>
        </Marker>

        <!-- PLAN-0631 D31-03: approval pending must be a readable status region even when
             the decision modal is dismissed; it is not dismissible and not clickable. -->
        <Marker
            v-if="pendingApproval"
            data-testid="chat-approval-waiting"
            role="status"
            aria-live="polite"
            class="mx-4 mt-2 rounded-lg border border-border bg-card px-3 py-2"
        >
            <MarkerIcon>
                <ShieldAlert class="size-3.5" aria-hidden="true" />
            </MarkerIcon>
            <MarkerContent>
                <span class="font-medium text-foreground">{{ approvalWaitingLabel }}</span>
                <span class="ml-2">{{ pendingApproval.tool }}</span>
            </MarkerContent>
        </Marker>

        <MessageList
            v-if="messages.length > 0"
            :messages="renderedMessages"
            :runs="sessionRuns"
            :anchors="derivedAnchors"
            :anchors-hidden-count="derivedAnchorsHiddenCount"
            :branch-busy="creatingBranchForMessageId !== null"
            :has-older="hasOlderMessages"
            :loading-older="loadingOlder"
            :folded-count="foldedMessageCount"
            :expanded-reached-limit="expandedMessageCount >= MAX_EXPANDED_MESSAGES"
            @load-older="loadOlderMessages"
            @approve="approveTool"
            @reject="rejectTool"
            @delete="handleDeleteMessage"
            @retry="handleRetry"
            @branch="handleCreateBranch"
            @revert="openRevertPreview"
            @open-session="onFollowUpNavigate"
        />

        <div
            v-else
            class="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center gap-4 px-4"
        >
            <div class="text-2xl font-semibold text-muted-foreground">xihe</div>
            <p class="text-sm text-muted-foreground text-center max-w-md">
                你好，我是 xihe Agent。有什么我可以帮你的？
            </p>
            <div class="flex flex-wrap gap-2 justify-center max-w-md">
                <button
                    v-for="suggestion in suggestions"
                    :key="suggestion"
                    class="px-3 py-1.5 text-xs rounded-full border border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                    @click="handleSend(suggestion)"
                >
                    {{ suggestion }}
                </button>
            </div>
        </div>

        <GuidancePanel
            v-if="lastRunId"
            ref="guidancePanelRef"
            :run-id="lastRunId"
            :run-status="currentRunStatus"
        />

        <TeamBoardPanel
            v-if="teamTasksStore.hasContent"
            :tasks="teamTasksStore.rows"
            :task-no-by-id="teamTasksStore.taskNoById"
            :dropped="teamTasksStore.dropped"
            :loading="teamTasksStore.loading"
            :error="teamTasksStore.error"
            :highlighted-task-id="boardHighlightTaskId"
            @retry="onBoardRetry"
            @navigate="onBoardNavigate"
        />

        <FollowUpQueuePanel
            v-if="followUpQueue && followUpQueue.outstandingCount > 0"
            :snapshot="followUpQueue"
            :messages="messages"
            :branch-labels="branchLabels"
            :busy-item-id="followUpQueueBusyItemId"
            :continuing="followUpQueueContinuing"
            :error="followUpQueueError"
            @withdraw="withdrawFollowUp"
            @continue="continueFollowUpQueue"
            @navigate="onFollowUpNavigate"
        />

        <button
            v-if="showReopenPill"
            ref="reopenPillRef"
            type="button"
            data-testid="pending-approval-reopen-pill"
            class="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm transition hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="reopenApproval"
        >
            <span class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 font-medium">{{ approvalWaitingLabel }}</span>
                <span class="truncate text-muted-foreground">{{ pendingApproval?.tool }}</span>
            </span>
            <span class="shrink-0 font-medium text-primary">{{
                t("chat.pendingApprovalReopenAction")
            }}</span>
        </button>

        <!--
            task-161 / D-1785：恢复投放队列的位置标记。position 直接来自 CP（不本地推算），
            「前面还有 N 个」就是它；点「查看」跳到对应 run 的消息/等待卡。
        -->
        <div
            v-if="dispatchQueue.length > 0"
            data-testid="dispatch-queue-notice"
            class="mx-4 mb-2 flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
        >
            <div
                v-for="entry in dispatchQueue"
                :key="entry.runId"
                class="flex items-center justify-between gap-3"
            >
                <span class="min-w-0 truncate text-muted-foreground">
                    {{ t("chat.dispatchQueue.ahead", { count: entry.position }) }}
                </span>
                <button
                    type="button"
                    class="shrink-0 font-medium text-primary transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    :data-testid="`dispatch-queue-jump-${entry.runId}`"
                    @click="jumpToQueuedRun(entry.runId)"
                >
                    {{ t("chat.dispatchQueue.jump") }}
                </button>
            </div>
        </div>

        <!-- task-188 S3：steer 插话 —— 复用既有 composer，模式横幅标注 submit 去向。 -->
        <div
            v-if="steerMode"
            class="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-xs"
            data-testid="steer-mode-banner"
        >
            <span class="font-medium">{{ t("steer.modeTitle") }}</span>
            <label class="inline-flex items-center gap-1">
                <span class="text-muted-foreground">{{ t("steer.targetLabel") }}</span>
                <select
                    v-model="steerTargetId"
                    class="max-w-40 truncate rounded border bg-background px-1.5 py-1"
                    data-testid="steer-target-select"
                >
                    <option
                        v-for="target in steerTargets"
                        :key="target.childSessionId"
                        :value="target.childSessionId"
                    >
                        {{ target.name ?? target.childSessionId.slice(0, 8) }}
                    </option>
                </select>
            </label>
            <span class="text-muted-foreground">{{ t("steer.modeHint") }}</span>
            <button
                type="button"
                class="ml-auto shrink-0 font-medium text-primary transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="steer-cancel"
                @click="exitSteerMode"
            >
                {{ t("steer.cancel") }}
            </button>
            <p
                v-if="steerError"
                role="alert"
                class="basis-full text-destructive"
                data-testid="steer-error"
            >
                {{ steerError.copy }}
            </p>
        </div>
        <button
            v-else-if="steerEntryVisible"
            type="button"
            class="mx-4 mb-2 self-start rounded-lg border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="steer-entry"
            @click="enterSteerMode"
        >
            {{ t("steer.entry") }}
        </button>

        <InputArea
            ref="inputComponent"
            :session-id="sessionId"
            :is-streaming="isStreaming"
            :queue-mode="followUpQueueMode"
            :queue-full="followUpQueueFull"
            :queue-paused="followUpQueue?.queueState === 'paused'"
            :queue-submitting="followUpQueueSubmitting"
            :queue-action-busy="followUpQueueBusyItemId !== null || followUpQueueContinuing"
            @send="onInputSend"
            @queue="handleFollowUpQueue"
            @stop="stopStreaming"
        />

        <ApprovalModal
            :approval="pendingApproval"
            :show="showApproval"
            :busy="approvalSubmitting"
            :error="approvalError"
            :can-classify="canClassifyApproval"
            :queue-total="sessionPendingApprovals.length"
            :draft="agentStore.approvalDrafts[pendingApproval?.requestId ?? ''] ?? ''"
            :resolved-elsewhere="
                agentStore.resolvedElsewhereRequests[pendingApproval?.requestId ?? ''] === true
            "
            @update:draft="agentStore.setApprovalDraft(pendingApproval?.requestId ?? '', $event)"
            @approve="decideApproval"
            @reject="decideApproval"
            @dismiss="handleApprovalDismiss"
        />

        <RevertPreviewDialog
            :show="revertPreviewSliceRef !== null"
            :workspace-id="authStore.currentWorkspaceId ?? ''"
            :slice-ref="revertPreviewSliceRef ?? ''"
            :busy="revertBusy"
            :error="revertError"
            @confirm="confirmRevert"
            @close="closeRevertPreview"
        />

        <RevertResultDialog
            :show="revertResult !== null"
            :workspace-id="authStore.currentWorkspaceId ?? ''"
            :result="revertResult"
            @retry="retryRevert"
            @close="closeRevertResult"
        />

        <ProviderBindingGuideDialog
            :show="providerBindingGuide !== null"
            :reason="providerBindingGuide?.reason ?? 'provider_required'"
            :detail="providerBindingGuide?.detail ?? null"
            @close="closeProviderBindingGuide"
            @retry="retryProviderBindingGuide"
            @settings="openProviderSettings"
        />
        <SSEStream
            :session-id="sessionId"
            :tool-mode="toolMode"
            :active="true"
            ref="streamComponent"
            @derived-state-refresh="handleDerivedStateRefresh"
        />
    </div>
</template>
