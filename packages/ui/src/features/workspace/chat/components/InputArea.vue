<script setup lang="ts">
import { ref, computed, inject, markRaw, nextTick, onBeforeUnmount, watch } from "vue";
import { useElementSize } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { useSessionParticipantsStore } from "../../stores/sessionParticipants";
import { useWorkspaceStore } from "../../stores/workspace";
import { useAuthStore } from "../../../../stores/auth";
import { useAgentStore } from "../../../../stores/agent";
import { routeLocationKey } from "vue-router";
import { isWorkspaceLessRoute } from "../workspaceLess";
import { useChatStore } from "../stores/chat";
import type { AttachmentFile, FileNode } from "../../../../types";
import type { SessionParticipantView } from "../../../../types/participant";
import { toast } from "vue-sonner";
import { problemDetailText } from "../../../../lib/errorMessages";
import { Send, Square, LoaderCircle, CornerUpRight, Plus, Info } from "@lucide/vue";
import ImageUpload from "../../../../components/multimodal/ImageUpload.vue";
import FileUpload from "../../../../components/multimodal/FileUpload.vue";
import ScreenshotCapture from "../../../../components/multimodal/ScreenshotCapture.vue";
import VoiceInput from "../../../../components/multimodal/VoiceInput.vue";
import RecipientField from "./RecipientField.vue";
import InputToolbar, { type ToolbarAction } from "./InputToolbar.vue";
import { uploadAttachments, validateAttachment } from "../../../../services/attachmentService";
import DelegationDialog, {
    type DelegationBudgetView,
    type DelegationPrincipal,
} from "./DelegationDialog.vue";
import { useDelegationPermission } from "../composables/useDelegationPermission";
import { useComposerPreferences } from "../composables/useComposerPreferences";
import { api } from "../../../../composables/api";
import { logger } from "../../../../lib/logger";
import {
    commandReasonKey,
    useSessionCommands,
    type SlashCommand,
} from "../composables/useSessionCommands";

/**
 * PLAN-0635 M2: the `@` menu carries **two groups in one listbox** (D35-01/03) — session
 * members and workspace files/directories. Two separate menus would duplicate the keyboard and
 * aria contract, so the grouping lives in the data (`group`) and is only a rendering concern.
 */
type TriggerGroup = "command" | "member" | "file";

/** One row of the unified trigger menu (`/` command, `@` member or `@` file). */
interface TriggerItem {
    /** Unique per menu — the textarea's `aria-activedescendant` points at it. */
    id: string;
    label: string;
    hint: string;
    group: TriggerGroup;
    /** Slash options only: server says the command may not run (kept visible, greyed out). */
    disabled?: boolean;
}

/** A rendered group: a heading plus its options carrying their flat index in the menu. */
interface MenuGroup {
    id: TriggerGroup;
    titleKey: string;
    items: (TriggerItem & { flatIndex: number })[];
}

/** Upper bound on file candidates in the menu — path matching is cheap but the list is long. */
const MAX_FILE_CANDIDATES = 8;

const URL = window.URL;

const props = defineProps<{
    sessionId: string;
    isStreaming?: boolean;
    queueMode?: boolean;
    queueFull?: boolean;
    queuePaused?: boolean;
    queueSubmitting?: boolean;
    queueActionBusy?: boolean;
}>();

const emit = defineEmits<{
    send: [
        content: string,
        attachments?: AttachmentFile[],
        asParticipantId?: string,
        cc?: string[],
        toParticipantIds?: string[],
        /** task-129：草稿代次（内容一变就 +1，含清空）——幂等键槽据此判断「这是不是同一份稿」。 */
        draftRevision?: number,
    ];
    queue: [
        content: string,
        attachments?: AttachmentFile[],
        asParticipantId?: string,
        cc?: string[],
        toParticipantIds?: string[],
        /** task-129：草稿代次，见 send 的同名字段。 */
        draftRevision?: number,
    ];
    stop: [];
}>();

const { t } = useI18n();

/**
 * PLAN-0630 M5b (D30-14)：speak-as 下拉升级为 **to 栏**（本次消息的主要响应者，单选）。
 * - 入口仍由 `capabilities.speakAs`（同一响应里的归约）决定**显不显示**，false 时**不渲染**；
 * - 候选 = store 的 `speakAsCandidates`（`selfOwned === true` 且未停用）——只有能说的人才出现在 to；
 * - 默认 = PRIMARY participant（D30-14），没有 PRIMARY 行时回落到自己的 HUMAN 行、再退回第一个；
 * - **纯前端状态**：改变 to 不写回参与者行 —— 会话身份是 `session_participants` 的 PRIMARY 行
 *   （`sessions.agent_principal_id` 已由 V133 删除），每次 Run 的应答者记在 `chat_runs` 自己的
 *   `agent_principal_id` 列上，绑定期的路径 cap 快照留在 `sessions.agent_permissions_snapshot`；
 *   选定值只随本条消息以 `asParticipantId` 发出。
 */
const participantsStore = useSessionParticipantsStore();
/** PLAN-0635 M2: already-loaded workspace tree feeds `@文件/目录` candidates (no request here). */
const workspaceStore = useWorkspaceStore();
const authStore = useAuthStore();
const delegationAgentStore = useAgentStore();
// PLAN-0655 T1.2: capability-atom read (SPAWN_AGENT in this workspace) — grey vs. clickable only;
// the spawn POST re-evaluates the same atom server-side.
const delegationPermission = useDelegationPermission(() => authStore.currentWorkspaceId ?? "");
const delegationOpen = ref(false);
const delegationSubmitting = ref(false);
const delegationPrincipals = ref<DelegationPrincipal[]>([]);
const delegationBudget = ref<DelegationBudgetView | null>(null);
/** Bound to one pending spawn attempt so the 202 replay reuses the SAME Idempotency-Key. */
const delegationIdempotencyKey = ref<string | null>(null);
const pendingApprovalRequestId = ref<string | null>(null);
/** The payload waiting behind an approval (re-posted with its grant header when approved). */
const delegationPending = ref<{ principalId: string; task: string } | null>(null);

async function refreshDelegationBudget() {
    try {
        delegationBudget.value = await api.delegationUsage(props.sessionId);
    } catch (error) {
        logger.warn("failed to read delegation usage", error);
        delegationBudget.value = null;
    }
}

async function openDelegation() {
    delegationOpen.value = true;
    delegationIdempotencyKey.value = null;
    pendingApprovalRequestId.value = null;
    delegationPending.value = null;
    void refreshDelegationBudget();
    // Principals for the picker (bound && enabled); the budget row reads GET /delegation-usage
    // above so the dialog opens with the real usage of this Session's delegation root.
    try {
        const workspaceId = authStore.currentWorkspaceId;
        if (!workspaceId) return;
        const agents = await api.getWorkspaceAgents(workspaceId);
        delegationPrincipals.value = agents
            .filter((agent) => agent.bound && !agent.disabled)
            .map((agent) => ({ principalId: agent.principalId, name: agent.name }));
    } catch (error) {
        logger.warn("failed to load delegation principals", error);
        delegationPrincipals.value = [];
    }
}

/**
 * PLAN-0655 T1.4: POST /delegation-spawn with a stable Idempotency-Key per attempt. 201 finishes
 * the delegation; 202 parks it behind the existing approval flow (CP already emits the SSE
 * approval_request on this session, so the normal approval card renders it) and the watcher below
 * replays with the grant header once the card resolves it.
 */
async function submitDelegation(
    payload: { principalId: string; task: string },
    approvalRequestId?: string,
) {
    delegationSubmitting.value = true;
    try {
        delegationIdempotencyKey.value ??= crypto.randomUUID();
        const answer = await api.delegationSpawn(
            props.sessionId,
            { agentPrincipalId: payload.principalId, task: payload.task },
            delegationIdempotencyKey.value,
            approvalRequestId,
        );
        if ("approvalRequestId" in answer) {
            pendingApprovalRequestId.value = answer.approvalRequestId;
            delegationPending.value = payload;
            toast.info(t("chat.delegation.approvalPending"));
            return;
        }
        toast.success(t("chat.delegation.created"));
        delegationIdempotencyKey.value = null;
        pendingApprovalRequestId.value = null;
        delegationPending.value = null;
        delegationOpen.value = false;
        void refreshDelegationBudget();
        // T1.5: answer.childSessionId / rootSessionId feed the session tree + badge surface.
    } catch (error) {
        logger.error("delegation spawn failed", error);
        toast.error(t("chat.delegation.submitFailed"));
    } finally {
        delegationSubmitting.value = false;
    }
}

function handleDelegationSubmit(payload: { principalId: string; task: string }) {
    void submitDelegation(payload);
}

// The approval card resolves decisions into the agent store; watch OUR pending id so the human
// never repeats the form after granting (same Idempotency-Key => no second budget spend).
watch(
    () =>
        pendingApprovalRequestId.value
            ? delegationAgentStore.resolvedApprovals[pendingApprovalRequestId.value]?.state
            : undefined,
    (state) => {
        if (!pendingApprovalRequestId.value) return;
        if (state === "approved" && delegationPending.value) {
            void submitDelegation(delegationPending.value, pendingApprovalRequestId.value);
        } else if (state === "rejected" || state === "expired") {
            pendingApprovalRequestId.value = null;
            delegationPending.value = null;
            delegationIdempotencyKey.value = null;
            toast.error(t("chat.delegation.approvalRejected"));
        }
    },
);
/** PLAN-0635 M3: `/export` and `/compact` are branch-scoped — read the selected branch here. */
const chatStore = useChatStore();
/** 无 router 的组件单测里注入结果为空 ⇒ 判定为「非独立会话」（见 workspaceLess.ts 注释）。 */
const route = inject(routeLocationKey, null);
const speakAsId = ref("");

const speakAsOptions = computed(() => participantsStore.speakAsCandidates);

/**
 * task-547 F-A（D-1409 判据⑤）：独立会话下「发送」与「定向」**不渲染**。
 *
 * <p>理由不是"能力面该不该有"，而是**界面上存在一个选了之后必然 400 的控件** ——
 * CP 对 workspace-less Session 的 as/to/cc/附件一律 `WORKSPACE_LESS_FEATURE_FORBIDDEN`。
 * 修法是「别让用户走完三步再失败」，所以入口就不给；能说出原因的一句提示见下方
 * `composer-workspace-less-hint`（可见文案，不是只在控制台 warn）。</p>
 */
const workspaceLess = computed(() => isWorkspaceLessRoute(route));

// task-555（判据⑤成员④）：附件类控件必须在**控件层**就不可用，不能只靠 ChatPanel 发送层兜底。
//
// 真栈实测（drivers/p96-fa-555.mjs，独立会话）：改动前「图片 / 附件 / 截取屏幕」三个按钮
// visible=true、disabled=false —— 用户能点开、选完文件才在提交时被拦，属「可见且可选但必失败」。
//
// 修法选**移除入口**而不是「保留但禁用」：①与 F-A 处理发送/代发两栏同一口径（移除 + 可见原因）；
// ②先试过给子组件传 `disabled`（fallthrough），实测只有 ScreenshotCapture 的根节点是单根 button
// 能被禁用，ImageUpload / FileUpload 是多根组件 ⇒ attrs 被丢弃，两个按钮仍然可点（假绿风险）。
// 一个永远点不动的按钮不会告诉用户"为什么"，而 composer 里的 workspaceLessNoTargets 已经写明原因。
const attachmentLocked = computed(() => workspaceLess.value);

const showSpeakAs = computed(() => participantsStore.canSpeakAs && speakAsOptions.value.length > 0);

/** 只有真的选了候选才带 `asParticipantId`：空串不发，避免把"以某人身份"误当默认行为。 */
const activeSpeakAsId = computed(() =>
    showSpeakAs.value && speakAsOptions.value.some((item) => item.participantId === speakAsId.value)
        ? speakAsId.value
        : "",
);

/**
 * PLAN-0665 M2（Q3，D4）+ task-88：**发送（多选收件人）**。与上面的「代发」是两件事：
 * - 候选 = 会话里未停用、有显示名的参与者，**不分 AGENT / HUMAN**。task-65 起 CP 接受人类目标：
 *   真人收到的就是「重要通知」本身、不会作答 ⇒ 结果落 202 的 `notifiedTargets[]`，
 *   run 归属仍是请求序里第一个能作答的智能体（task-87）；
 * - 选中 1..N 个 ⇒ 随消息以 `toParticipantIds` 发出；
 * - 默认不选（空集 = 旧单响应者路径），不写回 Session 绑定、不落 localStorage。
 * 纯真人会话里这一栏也必须出现（task-88 判据 1）——「只能发给智能体」是旧口径，已废弃。
 */
const toTargetIds = ref<string[]>([]);

/**
 * task-102（Lead 2026-11-15，源 = `runtime-1` 的 `task-104` CP 判据）：**调用者自己的真人行不进收件人/抄送候选**。
 *
 * <p>CP 侧今天有两个不同的 400 码（**别混成一个**）：</p>
 * <ul>
 *   <li>`PARTICIPANT_SELF_TARGET`（`ChatController:743`，task-104）= **TO 指向调用者自己的行**
 *       ⇒ 本卡负责：把自己的真人行从 TO/CC 候选里剔掉，用户构造不出这个请求；</li>
 *   <li>`AS_SELF_WITHOUT_TARGET`（`ChatController:689-705`，task-110 / Lead 裁定 B）= **`as` = 自己的真人行
 *       且 TO 缺席**。这一格是死信（responder = HUMAN ⇒ `agent_principal_id` = NULL ⇒ run 建不起来），
 *       CP 显式拒绝；`as` 候选**本卡不动**（下面 `speakAsOptions` 仍是 `speakAsCandidates` 原样），
 *       只给这个码专门的 toast 文案。</li>
 * </ul>
 * <p>而 **A 是 AGENT** ⇒ 202 正常形态（`as ∈ TO` 时 run 归属某个目标，`task-87` 从首个 AGENT 目标派生
 * `as`）⇒ **UI 不得剔除**，所以这里只剔 `HUMAN` 行。</p>
 *
 * <p>为什么先做 UI 而不是只靠 CP 400：400 是「发出去才失败」——用户已经写完消息、点完发送；
 * 候选里根本没有自己这一行才不会走到那一步。**名册可以含本人**（CP 自己有 self-only HUMAN 行的概念，
 * `SessionParticipantService:220/247`；来源 = 有人显式把本人加为参与者，或 workspace-less 且
 * `agent-runtime.defaultParticipants` 列了本人）⇒ 不能以「默认新建会话不会有」为由不做。</p>
 */
const currentUserId = computed(() => authStore.user?.id ?? "");

/**
 * 「这一行就是调用者本人」——**与 CP 同形**：`ChatController.java:1157` 的
 * `isSelfPrincipal(view.principalId(), userId)` 是按 `principalId` 比、**不看** `principalKind`
 * （AGENT 行的 `principalId` 是 agent principal id，永不等 user id ⇒ 该谓词对 AGENT 恒 false）。
 * 两处（候选剔除 / 提及名册）共用这一个比较，避免出现「同一份数据、两套本人判定」。
 */
function isSelfPrincipalRow(item: SessionParticipantView): boolean {
    return Boolean(currentUserId.value) && item.principalId === currentUserId.value;
}

/** TO/CC 候选里的「自己的真人行」：在 {@link isSelfPrincipalRow} 上加 kind 断言当绊网。 */
function isOwnHumanRow(item: SessionParticipantView): boolean {
    // 只剔 HUMAN：AGENT 行的 `principalId` 是 agent principal id，本就不可能等于 user id，
    // 这里显式按 kind 判而不是「反正不可能相等」—— 后者在有人改投影口径时会静默变成错过滤。
    return item.principalKind === "HUMAN" && isSelfPrincipalRow(item);
}

const toTargetCandidates = computed(() =>
    (participantsStore.participants ?? []).filter(
        (item) => !item.disabledAt && Boolean(item.displayName) && !isOwnHumanRow(item),
    ),
);

const showToTargets = computed(() => toTargetCandidates.value.length > 0);

const activeToTargetIds = computed(() =>
    toTargetIds.value.filter((id) =>
        toTargetCandidates.value.some((item) => item.participantId === id),
    ),
);

/**
 * task-450（F-12 / D-1273）：用户**是否动过**定向栏。
 * wire 上「省略 toParticipantIds」= 旧单响应者路径（主体作答），「显式 []」= 谁都不通知（CP 抑制）。
 * 清空 chips 是**明确的用户意图**，不能退化成「没提收件人」——真栈实测过这个退化：
 * 清空后请求体根本没有该键，CP 于是 fanOut，智能体照常回话
 * （evidence/2026-11-14-instance-flow-audit/task450-empty-to-payload.json）。
 */
const toTargetsTouched = ref(false);

/**
 * task-126 F3：深链「不可满足」的**用户可见面**（`blocked_unsat` 的落点）。
 *
 * <p>只点名 **id**，不点名名字 —— 这些人**不在本会话名册**里，所以根本取不到 `displayName`
 * （`payload` 里也只有 id）。写「部分收件人无效」既没点名、也没告诉用户该核对什么；
 * 写成「按 id 展示是因为查不到这些人，请手动确认收件人」才把**下一步动作**说清楚。</p>
 *
 * <p>一次性：`prefillDraft` 返回 `blocked_unsat` 后调用方会消费掉深链参数 ⇒ 不会重试 ⇒
 * 不会每次路由变化都刷一遍。用户可手动关掉。</p>
 *
 * <p>**声明位置**：必须早于下面 `watch(() => props.sessionId, …)`（`immediate: true` 在 setup 期就会读它）
 * —— 否则是 TDZ，整棵组件 setup 抛错（2026-11-15 实测：39 条单测全红在 `:561`）。</p>
 */
const unsatRecipients = ref<string[]>([]);

function onToTargetsFieldChange(ids: string[]): void {
    toTargetIds.value = [...ids];
    toTargetsTouched.value = true;
    // task-17：一旦重新选了收件人，上一条留下的「谁都不通知」提示就不再成立，必须立刻消失
    // （留着就是在说谎）；一次性额度已用掉，不再重放。
    if (ids.length > 0) showToEmptyHint.value = false;
}

/**
 * task-453（F-16 / D-1300）：**显式定向优先于默认代发**。
 * CP（ChatController:569-577，PLAN-0665 M1/Q1）：TO 非空时 `asParticipantId` 必须等于**首目标**
 * 或缺席，否则 400 `INVALID_REQUEST`。而上面那个 watch 会把代发自动默认成 PRIMARY（D30-14 的
 * 历史语义：那时「发送」栏就是单 TO）⇒ 用户一用定向栏就必然冲突，且只看到一句英文 detail。
 * 这里让**默认**让位：相等则保留，不等则省略；`speakAsId` 本身不清空 ⇒ 撤掉定向后自动恢复。
 * 可见 chip 也绑这个有效值（不能显示「以 A 身份发」而 wire 里其实没有 A）。
 * task-87 补充：省略 `as` 现在正是「首目标是真人」时的正确形态 —— CP 把 run 归属交给请求序里
 * 第一个 AGENT 目标，不再把它当`as`去跑 speak-as 闸；UI 这里不需要为真人目标做别的。
 */
const effectiveSpeakAsId = computed(() => {
    const targets = activeToTargetIds.value;
    if (targets.length === 0) return activeSpeakAsId.value;
    return activeSpeakAsId.value === targets[0] ? activeSpeakAsId.value : "";
});

const speakAsOverriddenByTo = computed(
    () => Boolean(activeSpeakAsId.value) && !effectiveSpeakAsId.value,
);

/** 发送用的 TO 载荷：非空 ⇒ 数组；空但动过 ⇒ **显式 []**；从未动过 ⇒ undefined（省略）。 */
const toTargetsPayload = computed(() => {
    if (activeToTargetIds.value.length > 0) return [...activeToTargetIds.value];
    return toTargetsTouched.value ? [] : undefined;
});

/**
 * task-17（源 = task-6 候选 C-1）：**显式空 TO 的语义可见性**。
 *
 * <p>问题（`[实测]` task-450 真栈取证）：清空定向栏后发送，wire 上是**显式 `[]`**、CP 抑制通知
 * ⇒ 消息真发出去了、真一个人都没通知，而界面与正常发送**一模一样**。用户要么以为已通知某人，
 * 要么以为没发出去而重发。三态（省略 / 显式 [] / 非空）已由 `InputAreaToTargets.spec.ts` 钉住，
 * 这里只补「界面说一句」，**不改 wire**。</p>
 *
 * <p>为什么是「一次性」而不是常驻：这句话教的是**语义**（清空 TO 等于谁都不通知），学会一次就够；
 * 常驻会同时违反两条判据 —— ①每屏多一行常驻警示（注意力预算），②常驻高度会进 composer 高度链
 * （`--xh-composer-h` 被浮动态 dock 依赖）。也不走 sonner toast：那条通道是**错误**通道
 * （`发送失败`），把「本条不通知任何人」混进去会让用户以为发送失败。</p>
 *
 * <p>三条判据（缺一不算完成）：①动过定向栏且最终为空 ⇒ 提示 1 次、`send` 第 5 参仍 `[]`；
 * ②**从未动过定向栏 ⇒ 0 次**（防「逢发必提示」）；③连发 2 次只出现 1 次。</p>
 */
const showToEmptyHint = ref(false);
/** 一次性：整个组件生命周期只提示一次（跨会话也不重复打扰；换会话只清可见性，不复位它）。 */
const toEmptyHintUsed = ref(false);

/**
 * 发送时判一次「显式空 TO」。判据故意与 `toTargetsPayload` 同源（`[]` 才提示），
 * 而不是另算一遍 `touched && empty` —— 两种算法迟早会漂（wire 改了三态、提示还按旧判据）。
 */
function markEmptyToHint(): void {
    if (toEmptyHintUsed.value) return;
    const payload = toTargetsPayload.value;
    if (!Array.isArray(payload) || payload.length > 0) return;
    toEmptyHintUsed.value = true;
    showToEmptyHint.value = true;
}

/**
 * PLAN-0630 M5b (D30-14)：`抄送`栏 = 旁听名单（多选 chips，2026-11-04 起为「输入 + 候选浮层」）。
 * - 候选 = 会话的未停用参与者（store 的单一数据源），排除 to 已选中的那个；
 * - 纯前端状态：不写回任何绑定，只随本条消息以 `cc`（participantId 数组）发出；
 * - 被点名的参与者自动加入抄送（见下方 watch）；用户点 × 移除后，同一个 @ 不再自动加回
 *   （`ccSuppressed` 记住手动移除），直到该 @ 从文本里消失再重新出现。
 *
 * 声明必须早于下方 `watch(props.sessionId, …, { immediate: true })`：该 watch 在 setup 期
 * 就会调用 `resetCc()`。
 */
const ccIds = ref<string[]>([]);
/** 手动移除过的自动 cc：文本里还挂着这个 @ 时不再自动加回。非响应式（只在 watch 内读写）。 */
let ccSuppressed = new Set<string>();

/**
 * 抄送候选：未停用、有显示名、也不是「发送」栏当前选中的那个。
 * 已在抄送里的由 `RecipientField` 自己过滤，这里不再重复排除（否则移除后无法再选回）。
 */
const ccCandidates = computed(() =>
    (participantsStore.participants ?? []).filter(
        (item) =>
            !item.disabledAt &&
            Boolean(item.displayName) &&
            // task-102：与「发送」同一口径 —— 自己的真人行不进抄送候选（CP 同样 400）。
            !isOwnHumanRow(item) &&
            // task-453 follow-up（Lead 准）：按**有效**代发排除 —— 让位时没有代发身份，
            // 不该把默认代发那个人从抄送候选里剔掉。
            item.participantId !== effectiveSpeakAsId.value &&
            !activeToTargetIds.value.includes(item.participantId),
    ),
);

/** 有抄送可选项（或已有 chips）时才出现抄送入口（与旧的 showCcBar 门一致）。 */
const showCcSection = computed(() => ccCandidates.value.length > 0 || ccIds.value.length > 0);

/**
 * 2026-11-04 用户裁定（composer 打磨）：抄送栏**默认收起**为「抄送 +」小按钮 —— ≥2 agent 的
 * 工作区不再因为"有候选"就常驻占一整行。展开只有两条路：① 已有 chips（含 @ 点名自动加入）；
 * ② 用户手动点开。chips 清空后允许手动收起；手动选择按**会话记忆**（composerPreferences，
 * 模块级 Map 不落 localStorage，刷新回默认收起）。
 */
const composerPreferences = useComposerPreferences();
const ccExpanded = ref(false);
const ccBarVisible = computed(
    () => showCcSection.value && (ccExpanded.value || ccIds.value.length > 0),
);

watch(
    () => props.sessionId,
    (sessionId) => {
        ccExpanded.value = sessionId ? composerPreferences.isCcExpanded(sessionId) : false;
        // task-17：换了会话就不该继续看到上一条的提示（它会指向另一条消息）；一次性额度不复位。
        showToEmptyHint.value = false;
    },
    { immediate: true },
);

// ① chips 出现（@ 自动加入 / 手动选）→ 自动展开；这是事件驱动，不写"手动记忆"。
watch(
    ccIds,
    (ids) => {
        if (ids.length > 0) ccExpanded.value = true;
    },
    { immediate: true },
);

function expandCc(): void {
    ccExpanded.value = true;
    composerPreferences.setCcExpanded(props.sessionId, true);
}

/** 只有 chips 清空后才允许收起（有 chips 时收起会让名字不可见，必须留在展开态）。 */
function collapseCc(): void {
    if (ccIds.value.length > 0) return;
    ccExpanded.value = false;
    composerPreferences.setCcExpanded(props.sessionId, false);
}

function resetCc(): void {
    ccIds.value = [];
    ccSuppressed = new Set<string>();
}

/**
 * 2026-11-04 用户裁定：`发送` 栏改为「输入 + 候选浮层」，单选，值仍是 participantId。
 * 清空（点 × 或 Backspace）时不猜测默认值 —— 空值就不带 `asParticipantId`。
 */
function onSpeakAsFieldChange(ids: string[]): void {
    speakAsId.value = ids[0] ?? "";
}

/**
 * 2026-11-04 用户裁定：`抄送` 栏改为「输入 + 候选浮层」，多选。手动移除的条目仍进
 * `ccSuppressed`（同一个 @ 不再自动加回），手动加回的则解除压制。
 */
function onCcFieldChange(ids: string[]): void {
    for (const id of ccIds.value) {
        if (!ids.includes(id)) ccSuppressed.add(id);
    }
    for (const id of ids) ccSuppressed.delete(id);
    ccIds.value = [...ids];
}

/**
 * T5b.2「@ 自动入抄送」：解析草稿里的 @token（规则镜像 CP 的 `MentionParser`——@ 前必须是
 * 词边界、名称贪婪最长匹配、后跟空白/结尾、重名歧义不落座、`@all` 不收），命中且未停用
 * 的参与者自动加入抄送 chips；文本里 @ 的用法不受影响。
 *
 * <p>task-115：**镜像面不止解析算法，还包括喂给算法的名册**。CP 在 `ChatController.mentionRoster`
 * （`:1151-1168`，task-104）里先剔掉调用者自己那一行（`:1157` `isSelfPrincipal`），注释
 * `:1142-1149` 写明理由是「@ 自己在正文里是文本、不是寻址行为」且「同一个过滤顺带把调用者挡在
 * 自己的 cc 观察者名单之外」。UI 此前用的是**原始名册** ⇒ 同一条 `@自己` 在两侧答案不同
 * （CP：不是提及；UI：是提及 ⇒ 还把它当**显式** cc id 发回去，而 CP 的显式 cc 通道没有自投递门）。
 * 所以这里对齐的是**输入名册**：匹配规则（本函数下半段）一行未动，也不在结果上打补丁。</p>
 */
function mentionedParticipantIds(text: string): string[] {
    const roster = (participantsStore.participants ?? []).filter(
        // `!disabledAt`：CP 把 `disabledAt` 交给 `MentionParser` 判（`RosterEntry.enabled()`，
        // `MentionParser.java:37-40` + `:63`「disabled participants are invisible」）⇒ 两侧等价。
        // `!isSelfPrincipalRow`：见上，与 `mentionRoster` 的 `:1157` 同口径。
        (item) => !item.disabledAt && Boolean(item.displayName) && !isSelfPrincipalRow(item),
    );
    if (roster.length === 0 || !text.includes("@")) return [];
    const ids: string[] = [];
    let index = 0;
    while (index < text.length) {
        const at = text.indexOf("@", index);
        if (at < 0) break;
        index = at + 1;
        // '@' 粘在前一个词后面（如邮箱地址）不是提及。
        if (at > 0 && !/\s/.test(text.charAt(at - 1))) continue;
        // @all 是保留 token：由 mention fan-out 处理，不自动入抄送。
        if (
            text.slice(at + 1, at + 4).toLowerCase() === "all" &&
            (at + 4 >= text.length || /\s/.test(text.charAt(at + 4)))
        ) {
            continue;
        }
        let best: (typeof roster)[number] | null = null,
            bestTies = 0;
        for (const item of roster) {
            const name = item.displayName!;
            if (!text.startsWith(name, at + 1)) continue;
            const boundary = at + 1 + name.length;
            if (boundary < text.length && !/\s/.test(text.charAt(boundary))) continue;
            if (best === null || name.length > best.displayName!.length) {
                best = item;
                bestTies = 1;
            } else if (name.length === best.displayName!.length) {
                bestTies += 1;
            }
        }
        if (best !== null && bestTies === 1 && !ids.includes(best.participantId)) {
            ids.push(best.participantId);
        }
    }
    return ids;
}

watch(
    () => props.sessionId,
    (id) => {
        // to/cc 是草稿级纯前端状态：换会话即重置，绝不跨会话残留。
        resetCc();
        // task-126 F3：深链「不可满足」提示同理 —— 它是给**这次**深链的读者看的，换会话即失效。
        unsatRecipients.value = [];
        void participantsStore.ensureLoaded(id ?? null);
    },
    { immediate: true },
);

watch(
    speakAsOptions,
    (options) => {
        if (options.some((item) => item.participantId === speakAsId.value)) return;
        // D30-14：默认 to = PRIMARY participant；无 PRIMARY（如纯人类会话）回落自己，绝不默认代别人。
        const primary = options.find((item) => item.role === "PRIMARY");
        const own = options.find((item) => item.principalKind === "HUMAN") ?? options[0];
        speakAsId.value = (primary ?? own)?.participantId ?? "";
    },
    { immediate: true },
);

const input = ref(""),
    isComposing = ref(false),
    attachments = ref<File[]>([]);

/**
 * task-129：**草稿代次**。
 *
 * <p>幂等键的语义是「同一份未改动草稿的上一次尝试」；只比内容不够 —— 用户「改稿 → 再改回原样」
 * 后内容与旧稿相同，但那已经是**新动作**（若首请求其实已落地，复用键会被 CP 判成重放，
 * 这条新消息就静默消失了）。代次只增不减，任何内容变化（含清空、程序化预填）都会 +1，
 * 所以「改回原样」也会得到新代次。</p>
 */
const draftRevision = ref(0);
watch(input, () => {
    draftRevision.value += 1;
});

/**
 * PLAN-0670 M2d.4：本地图片预览的 object URL 必须**创建必配对释放**。
 * 之前模板里 `attachmentObjectUrl(file)` 每次渲染都 `URL.createObjectURL`，从不 revoke ——
 * 选过图后整个 Blob 常驻内存。这里按 File 缓存（同一文件只建一次），移除/清空/卸载时 revoke。
 */
const attachmentObjectUrls = new Map<File, string>();

function revokeAttachmentUrl(file: File): void {
    const url = attachmentObjectUrls.get(file);
    if (!url) return;
    URL.revokeObjectURL(url);
    attachmentObjectUrls.delete(file);
}

function revokeAllAttachmentUrls(): void {
    for (const url of attachmentObjectUrls.values()) URL.revokeObjectURL(url);
    attachmentObjectUrls.clear();
}

onBeforeUnmount(revokeAllAttachmentUrls);

// T5b.2「@ 自动入抄送」：草稿变化时把 @命中 的参与者放进抄送 chips（解析规则见 mentionedParticipantIds）。
watch(input, (text) => {
    const mentioned = mentionedParticipantIds(text);
    // 文本里已经不含某个 @ 时，解除它的手动移除压制（下次重新 @ 会自动入 cc）。
    for (const id of ccSuppressed) {
        if (!mentioned.includes(id)) ccSuppressed.delete(id);
    }
    const additions = mentioned.filter((id) => !ccIds.value.includes(id) && !ccSuppressed.has(id));
    if (additions.length > 0) ccIds.value = [...ccIds.value, ...additions];
});
let uploadedByFile = new WeakMap<File, Map<string, AttachmentFile>>();
const attachmentErrors = ref<Record<string, string>>({});

/**
 * PLAN-0635 M1（D35-01）：`/` 命令与 `@` 提及共用**一个**输入触发器模型 —— 同一份候选渲染、
 * 同一套键盘（↑↓ / Enter / Tab / Esc）、同一套 aria。两套实现必然漂移，故不各写一份。
 */
type TriggerKind = "slash" | "mention";
const TRIGGER_MENU_ID = "chat-input-trigger-menu",
    triggerKind = ref<TriggerKind | null>(null),
    triggerFilter = ref(""),
    triggerIndex = ref(0),
    /** Index of the `@` that opened the mention menu (the replace range on insert). */
    mentionAnchor = ref(-1),
    showHelpPanel = ref(false),
    textareaRef = ref<HTMLTextAreaElement | null>(null),
    isUploading = ref(false);

/**
 * PLAN-0635 M3（D35-02）：菜单 = 服务端注册表 ∪ 本地表。
 *
 * 合并、按 name 去重、失败兜底都在 `useSessionCommands` 里（服务端优先、本地独有保留、请求失败
 * 仍有本地表）。这里只消费结果，不再维护第二套命令列表 —— `/clear` 与 `/help` 是纯浏览器动作，
 * 永远保留。
 */
const { commands: slashCommands } = useSessionCommands(computed(() => props.sessionId));

function isWordStart(value: string, index: number): boolean {
    return index === 0 || /\s/.test(value[index - 1] ?? "");
}

/**
 * Anchor of the `@` that should open the mention menu, or -1 when there is none.
 *
 * Boundary rule mirrors `MentionParser` (a `@` glued to a preceding word, e.g. an email address,
 * is not a token), and a whitespace after `@` ends the token — so `@al ice` never opens a menu.
 */
function findMentionAnchor(value: string, caret: number): number {
    const upto = value.slice(0, caret),
        at = upto.lastIndexOf("@");
    if (at < 0 || !isWordStart(upto, at)) return -1;
    return /\s/.test(upto.slice(at + 1)) ? -1 : at;
}

const slashItems = computed<TriggerItem[]>(() => {
    const filter = triggerFilter.value.toLowerCase();
    // One row per command name: aria ids and keyboard indices are derived from this list, so a
    // duplicate name would make two options share an id. (The composable already merges; this is
    // the menu's own guarantee.)
    const byName = new Map<string, SlashCommand>();
    for (const cmd of slashCommands.value) {
        if (filter && !cmd.key.toLowerCase().includes(filter)) continue;
        if (!byName.has(cmd.key)) byName.set(cmd.key, cmd);
    }
    return [...byName.values()].map((cmd) => ({
        id: `xihe-slash-${cmd.key.slice(1)}`,
        label: cmd.key,
        hint: cmd.disabled
            ? `${t(cmd.descriptionKey)} · ${t(commandReasonKey(cmd.reason))}`
            : t(cmd.descriptionKey),
        group: "command" as const,
        disabled: cmd.disabled,
    }));
});

/**
 * Candidates come from the **existing** participant store (same single source as the members
 * panel and the speak-as dropdown) — no endpoint, no second fetch.
 * Disabled participants are invisible here for the same reason `MentionParser` skips them.
 */
const memberItems = computed<TriggerItem[]>(() => {
    const filter = triggerFilter.value.toLowerCase();
    const items: TriggerItem[] = [];
    if ("all".startsWith(filter)) {
        items.push({
            id: "xihe-mention-all",
            label: "@all",
            hint: t("chat.input.mentionAll"),
            group: "member",
        });
    }
    for (const participant of participantsStore.participants ?? []) {
        const name = participant.displayName ?? "";
        if (!name || participant.disabledAt) continue;
        if (!name.toLowerCase().includes(filter)) continue;
        items.push({
            id: `xihe-mention-${participant.participantId}`,
            label: `@${name}`,
            hint:
                participant.principalKind === "AGENT"
                    ? t("chat.input.mentionAgent")
                    : t("chat.input.mentionHuman"),
            group: "member",
        });
    }
    return items;
});

/** Depth-first walk of the already-loaded workspace tree (no request is made here). */
function flattenFileTree(nodes: FileNode[], out: FileNode[] = []): FileNode[] {
    for (const node of nodes) {
        out.push(node);
        if (node.children?.length) flattenFileTree(node.children, out);
    }
    return out;
}

/**
 * PLAN-0635 M2: `@文件/目录` candidates come from the **already-loaded** `workspace.fileTree`
 * (filled by the view through `api.listDirectory`) — no new endpoint, no extra fetch (D35-03).
 *
 * Two deliberate rules:
 * <ul>
 *   <li>an <b>empty</b> filter lists nothing: otherwise every file in the workspace would flood
 *       the menu the moment the user types `@` and bury the member candidates;</li>
 *   <li>basename matches rank before deeper path matches, so typing `@input` offers
 *       `chat/components/InputArea.vue` instead of an arbitrary deep path containing "input".</li>
 * </ul>
 */
const fileItems = computed<TriggerItem[]>(() => {
    const filter = triggerFilter.value.toLowerCase();
    if (!filter) return [];
    const matched = flattenFileTree(workspaceStore.fileTree ?? []).filter((node) =>
        node.path.toLowerCase().includes(filter),
    );
    matched.sort((left, right) => {
        const leftName = left.name.toLowerCase().includes(filter) ? 0 : 1,
            rightName = right.name.toLowerCase().includes(filter) ? 0 : 1;
        if (leftName !== rightName) return leftName - rightName;
        return left.path.length - right.path.length;
    });
    return matched.slice(0, MAX_FILE_CANDIDATES).map((node, index) => ({
        // Index-based id keeps `aria-activedescendant` valid: a raw path can contain characters
        // that are not allowed in an IDREF.
        id: `xihe-file-${index}`,
        label: `@${node.path}`,
        hint:
            node.type === "directory"
                ? t("chat.input.mentionDirectory")
                : t("chat.input.mentionFile"),
        group: "file",
    }));
});

/** Member group first (existing behaviour), file group second — one listbox, two headings. */
const mentionGroups = computed<{ id: TriggerGroup; titleKey: string; items: TriggerItem[] }[]>(
    () => {
        const groups: { id: TriggerGroup; titleKey: string; items: TriggerItem[] }[] = [];
        if (memberItems.value.length) {
            groups.push({
                id: "member",
                titleKey: "chat.input.mentionsTitle",
                items: memberItems.value,
            });
        }
        if (fileItems.value.length) {
            groups.push({ id: "file", titleKey: "chat.input.filesTitle", items: fileItems.value });
        }
        return groups;
    },
);

const activeItems = computed<TriggerItem[]>(() => {
    if (triggerKind.value === "slash") return slashItems.value;
    if (triggerKind.value === "mention") return mentionGroups.value.flatMap((group) => group.items);
    return [];
});

/** What the template renders: headings + options with their flat index for `aria`/keyboard. */
const menuGroups = computed<MenuGroup[]>(() => {
    if (triggerKind.value === "slash") {
        return slashItems.value.length
            ? [
                  {
                      id: "command",
                      titleKey: "chat.input.commandsTitle",
                      items: slashItems.value.map((item, flatIndex) => ({ ...item, flatIndex })),
                  },
              ]
            : [];
    }
    if (triggerKind.value !== "mention") return [];
    let flatIndex = 0;
    return mentionGroups.value.map((group) => ({
        id: group.id,
        titleKey: group.titleKey,
        items: group.items.map((item) => ({ ...item, flatIndex: flatIndex++ })),
    }));
});

const menuOpen = computed(() => triggerKind.value !== null && activeItems.value.length > 0);

const activeItemId = computed(() => activeItems.value[triggerIndex.value]?.id ?? "");

const sendDisabled = computed(() => {
    if (props.queueMode) {
        return (
            !input.value.trim() ||
            Boolean(props.queueFull) ||
            Boolean(props.queueSubmitting) ||
            Boolean(props.queueActionBusy)
        );
    }
    return !input.value.trim() && attachments.value.length === 0;
});

const toolbarActions = computed<ToolbarAction[]>(() => [
    {
        key: "image",
        position: "left",
        // task-555：独立会话没有附件通道 ⇒ 入口整个不渲染（与 F-A 移除定向/代发两栏同一口径：
        // 「移除 + 可见原因」比「保留但禁用」更少歧义——用户看不到一个永远点不动的按钮）。
        visible: () => !attachmentLocked.value,
        component: markRaw(ImageUpload),
        props: { onUpload: addAttachment },
    },
    {
        key: "file",
        position: "left",
        // task-555：独立会话没有附件通道 ⇒ 入口整个不渲染（与 F-A 移除定向/代发两栏同一口径：
        // 「移除 + 可见原因」比「保留但禁用」更少歧义——用户看不到一个永远点不动的按钮）。
        visible: () => !attachmentLocked.value,
        component: markRaw(FileUpload),
        props: { onUpload: addAttachment },
    },
    {
        key: "screenshot",
        position: "left",
        // task-555：独立会话没有附件通道 ⇒ 入口整个不渲染（与 F-A 移除定向/代发两栏同一口径：
        // 「移除 + 可见原因」比「保留但禁用」更少歧义——用户看不到一个永远点不动的按钮）。
        visible: () => !attachmentLocked.value,
        component: markRaw(ScreenshotCapture),
        props: { onCapture: addAttachmentBlob },
    },
    {
        key: "voice",
        position: "left",
        component: markRaw(VoiceInput),
        props: { onTranscript: handleTranscript },
    },
    {
        key: "delegate",
        position: "right",
        component: "button",
        props: {
            class: "shrink-0 h-8 px-2 inline-flex items-center gap-1 rounded-lg border border-primary bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors",
            disabled: !delegationPermission.canDelegate.value,
            title: delegationPermission.reason(),
            "data-testid": "chat-delegate-button",
            "aria-label": t("chat.delegation.button"),
            onClick: () => void openDelegation(),
        },
        icon: markRaw(CornerUpRight),
        // task-30 ②：独立会话（workspace-less）连委派也没有通道 —— CP 对 as/to/cc/附件一律
        // `WORKSPACE_LESS_FEATURE_FORBIDDEN`，而这里原先只判了队列模式 ⇒ 提示条写着「仅纯对话」、
        // 旁边还摆着一个点了必失败的委派按钮。口径与 F-A / task-555 一致：**移除 + 可见原因**。
        visible: !workspaceLess.value && !props.queueMode,
    },
    {
        key: props.isStreaming ? "stop" : "send",
        position: "right",
        component: "button",
        props: {
            class: "shrink-0 size-8 flex items-center justify-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 transition-opacity",
            disabled: props.isStreaming ? false : sendDisabled.value,
            "data-testid": props.isStreaming ? "chat-stop-button" : "chat-send-button",
            "aria-label": props.isStreaming ? t("chat.stop") : t("chat.send"),
            onClick: props.isStreaming ? stopInput : handleSend,
        },
        icon: markRaw(props.isStreaming ? Square : Send),
        visible: props.isStreaming || !props.queueMode,
    },
]);

async function handleSend() {
    const text = input.value.trim();
    // A registered command submitted as text (menu already closed, e.g. a trailing space) must
    // still run through the command path — otherwise the literal "/help" would be emitted as the
    // user's message.
    const command = slashCommands.value.find((cmd) => cmd.key === text);
    if (command) {
        await executeSlash(command);
        return;
    }
    if (sendDisabled.value || isUploading.value || props.queueSubmitting || props.queueActionBusy)
        return;
    const uploadSessionId = props.sessionId;
    let uploadedForSubmit: AttachmentFile[] = [],
        uploadFailed = false;

    if (attachments.value.length > 0) {
        const filesToUpload = props.queueMode
            ? attachments.value.filter((file) => !uploadedByFile.get(file)?.has(uploadSessionId))
            : attachments.value;
        if (filesToUpload.length > 0) {
            isUploading.value = true;
            attachmentErrors.value = {};
            try {
                const { success, failed } = await uploadAttachments(uploadSessionId, filesToUpload);
                if (props.sessionId !== uploadSessionId) return;
                uploadedForSubmit = success;
                uploadFailed = failed.length > 0;
                for (const item of failed) {
                    attachmentErrors.value[item.name] = item.reason;
                    toast.error(`${item.name}: ${item.reason}`);
                }
                if (props.queueMode) {
                    const matchedFiles = new Set<File>();
                    for (const uploaded of success) {
                        const file =
                            filesToUpload.find(
                                (candidate) =>
                                    !matchedFiles.has(candidate) &&
                                    candidate.name === uploaded.name &&
                                    candidate.size === uploaded.size &&
                                    candidate.type === uploaded.type,
                            ) ??
                            filesToUpload.find(
                                (candidate) =>
                                    !matchedFiles.has(candidate) &&
                                    candidate.name === uploaded.name,
                            );
                        if (file) {
                            const bySession =
                                uploadedByFile.get(file) ?? new Map<string, AttachmentFile>();
                            bySession.set(uploadSessionId, uploaded);
                            uploadedByFile.set(file, bySession);
                            matchedFiles.add(file);
                        }
                    }
                }
            } finally {
                isUploading.value = false;
            }
        }
        if (props.queueMode) {
            uploadedForSubmit = attachments.value
                .map((file) => uploadedByFile.get(file)?.get(uploadSessionId))
                .filter((attachment): attachment is AttachmentFile => attachment !== undefined);
        }
    }

    if (props.queueMode && uploadFailed) return;
    if (attachments.value.length > 0 && uploadedForSubmit.length === 0) return;
    // task-17：本条真的要被发出去了 —— 此刻才判「显式空 TO」，提前判会把因校验失败而没发出去的那次也算上。
    markEmptyToHint();
    if (props.queueMode)
        emit(
            "queue",
            text,
            uploadedForSubmit.length > 0 ? uploadedForSubmit : undefined,
            effectiveSpeakAsId.value || undefined,
            ccIds.value.length > 0 ? [...ccIds.value] : undefined,
            toTargetsPayload.value,
            draftRevision.value,
        );
    else
        emit(
            "send",
            text,
            uploadedForSubmit.length > 0 ? uploadedForSubmit : undefined,
            effectiveSpeakAsId.value || undefined,
            ccIds.value.length > 0 ? [...ccIds.value] : undefined,
            toTargetsPayload.value,
            draftRevision.value,
        );
}

function stopInput() {
    emit("stop");
}

function closeTriggerMenu(): void {
    triggerKind.value = null;
    triggerFilter.value = "";
    triggerIndex.value = 0;
    mentionAnchor.value = -1;
}

/**
 * `/export` filename: prefer the server's `Content-Disposition`, fall back to the stable session
 * name. The server value is treated as untrusted text — only its basename is used.
 */
function exportFileName(contentDisposition: string | null): string {
    const fallback = `session-${props.sessionId}.md`;
    const match = contentDisposition?.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i);
    const raw = match?.[1]?.trim();
    if (!raw) return fallback;
    let decoded = raw;
    try {
        decoded = decodeURIComponent(raw);
    } catch (error) {
        logger.debug("Content-Disposition filename is not percent-encoded; using it verbatim", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    const base = decoded.split(/[\\/]/).pop()?.trim();
    return base || fallback;
}

function logCommandFailure(context: { command: string; sessionId: string }, error: unknown): void {
    logger.warn("Slash command failed", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
    });
}

/**
 * PLAN-0635 M3: `/export` = a real download. The registry decides whether the command may run; the
 * artifact itself comes from `GET /sessions/{id}/export?branchId=` as `text/markdown` + attachment.
 */
async function downloadSessionExport(): Promise<void> {
    const branchId = chatStore.getSelectedBranchId(props.sessionId);
    if (!branchId) {
        toast.error(t("chat.commands.branchUnavailable"));
        return;
    }
    let objectUrl: string | null = null;
    try {
        const response = await api.exportSession(props.sessionId, branchId);
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = exportFileName(response.headers.get("content-disposition"));
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    } catch (error) {
        logCommandFailure({ command: "/export", sessionId: props.sessionId }, error);
        // BL-288：413 EXPORT_TOO_LARGE 的 detail 带实际条数/上限/建议，优先展示它。
        toast.error(problemDetailText(error, t("chat.commands.failed")));
    } finally {
        // The click has already handed the blob to the browser; a leaked object URL would pin the
        // whole session export in memory.
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
}

/** PLAN-0635 M3: `/compact` reuses the existing manual-compaction endpoint (body needs `branchId`). */
async function compactSessionContext(): Promise<void> {
    const branchId = chatStore.getSelectedBranchId(props.sessionId);
    if (!branchId) {
        toast.error(t("chat.commands.branchUnavailable"));
        return;
    }
    try {
        await api.compactSession(props.sessionId, branchId);
        toast.success(t("chat.commands.compacted"));
    } catch (error) {
        logCommandFailure({ command: "/compact", sessionId: props.sessionId }, error);
        toast.error(t("chat.commands.failed"));
    }
}

/**
 * A slash command never becomes a chat message. Selecting one either runs a browser/server action
 * or opens the help panel; an unavailable command is refused with its localized reason (it is still
 * listed — hiding it would hide the capability itself).
 */
async function executeSlash(cmd: SlashCommand): Promise<void> {
    closeTriggerMenu();
    showHelpPanel.value = false;
    input.value = "";
    if (cmd.disabled) {
        toast.error(t(commandReasonKey(cmd.reason)));
        return;
    }
    if (cmd.key === "/help") {
        showHelpPanel.value = true;
        return;
    }
    // `/clear` = clear the draft (input + pending attachments) and send nothing.
    if (cmd.key === "/clear") {
        clearDraft();
        return;
    }
    if (cmd.key === "/export") {
        await downloadSessionExport();
        return;
    }
    if (cmd.key === "/compact") {
        await compactSessionContext();
        return;
    }
    // A command the registry knows but this UI does not implement yet: say so instead of doing
    // nothing silently (or sending the literal text to the model).
    toast.error(t("chat.commands.unknown"));
}

/**
 * Insert `@displayName ` at the trigger anchor.
 *
 * The trailing space is a **wire contract**, not cosmetics: `MentionParser` requires a whitespace
 * (or end-of-text) boundary after the name, otherwise the token stays literal and the participant
 * is never woken. Same format as the members-panel `insertMention` click path.
 */
function insertMentionToken(name: string): void {
    const element = textareaRef.value,
        caret = element?.selectionStart ?? input.value.length,
        anchor = mentionAnchor.value >= 0 ? mentionAnchor.value : caret,
        before = input.value.slice(0, anchor),
        after = input.value.slice(caret),
        inserted = `@${name} `;
    input.value = `${before}${inserted}${after}`;
    closeTriggerMenu();
    void nextTick(() => {
        const position = before.length + inserted.length;
        element?.setSelectionRange(position, position);
        element?.focus();
    });
}

function selectActiveItem(): void {
    const item = activeItems.value[triggerIndex.value];
    if (!item) return;
    if (triggerKind.value === "slash") {
        const command = slashCommands.value.find((cmd) => cmd.key === item.label);
        if (command) void executeSlash(command);
        return;
    }
    insertMentionToken(item.label.slice(1));
}

function pickItem(index: number): void {
    triggerIndex.value = index;
    selectActiveItem();
}

function handleKeydown(e: KeyboardEvent) {
    // IME composition owns Enter/arrow keys — never steal them or an IME confirm fires a command.
    if (isComposing.value) return;

    if (menuOpen.value) {
        const count = activeItems.value.length;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            triggerIndex.value = (triggerIndex.value + 1) % count;
            return;
        }
        if (e.key === "ArrowUp") {
            e.preventDefault();
            triggerIndex.value = triggerIndex.value > 0 ? triggerIndex.value - 1 : count - 1;
            return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            selectActiveItem();
            return;
        }
        if (e.key === "Escape") {
            e.preventDefault();
            closeTriggerMenu();
            return;
        }
    }

    if (e.key === "Escape" && showHelpPanel.value) {
        e.preventDefault();
        showHelpPanel.value = false;
        return;
    }

    if (e.key === "Enter" && !e.shiftKey && !isComposing.value) {
        e.preventDefault();
        if (props.queueMode) {
            handleSend();
        } else if (props.isStreaming) {
            stopInput();
        } else {
            handleSend();
        }
    }
}

function handleInput() {
    if (isComposing.value) return;
    showHelpPanel.value = false;
    const element = textareaRef.value,
        caret = element?.selectionStart ?? input.value.length,
        value = input.value;

    const at = findMentionAnchor(value, caret);
    if (at >= 0) {
        triggerKind.value = "mention";
        mentionAnchor.value = at;
        triggerFilter.value = value.slice(at + 1, caret);
        triggerIndex.value = 0;
        return;
    }

    if (value === "/" || (value.startsWith("/") && !value.includes(" "))) {
        triggerKind.value = "slash";
        triggerFilter.value = value.slice(1);
        mentionAnchor.value = -1;
        triggerIndex.value = 0;
        return;
    }

    closeTriggerMenu();
}

function addAttachment(files: File[]) {
    const validFiles: File[] = [];
    for (const file of files) {
        const validation = validateAttachment(file);
        if (!validation.valid) {
            toast.error(`${file.name}: ${validation.reason}`);
            continue;
        }
        validFiles.push(file);
    }
    attachments.value.push(...validFiles);
}

function addAttachmentBlob(blob: Blob) {
    const file = new File([blob], "capture.png", { type: "image/png" });
    addAttachment([file]);
}

function removeAttachment(index: number) {
    const file = attachments.value[index];
    if (file) {
        const nextErrors = { ...attachmentErrors.value };
        delete nextErrors[file.name];
        attachmentErrors.value = nextErrors;
        revokeAttachmentUrl(file);
    }
    attachments.value.splice(index, 1);
}

function handleTranscript(text: string) {
    input.value += text;
}

function attachmentObjectUrl(file: File): string {
    const existing = attachmentObjectUrls.get(file);
    if (existing) return existing;
    const url = URL.createObjectURL(file);
    attachmentObjectUrls.set(file, url);
    return url;
}

function focusInput(): void {
    const element = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]');
    element?.focus();
}

function clearDraft() {
    input.value = "";
    revokeAllAttachmentUrls();
    attachments.value = [];
    uploadedByFile = new WeakMap<File, Map<string, AttachmentFile>>();
    attachmentErrors.value = {};
    // cc 随本条消息发出后即清空，不带到下一条。
    resetCc();
}

/**
 * PLAN-0623：把 `@displayName` 插入草稿（参与者面板的"提及"）。
 * 只改本地草稿，不发消息 —— 发送仍走用户自己的发送动作。
 */
function insertMention(name: string): void {
    const mention = `@${name}`;
    const current = input.value;
    if (!current.trim()) {
        input.value = `${mention} `;
    } else if (current.endsWith(" ") || current.endsWith("\n")) {
        input.value = `${current}${mention} `;
    } else {
        input.value = `${current} ${mention} `;
    }
    focusInput();
}

/** C1：守卫把发送拦下时，ChatPanel 用它把草稿还给用户（不丢消息）。 */
function setDraft(text: string) {
    input.value = text;
}

/**
 * task-113 B 步（BL-339）：**丢弃必须可观测，且必须能区分两种完全不同的原因**。
 *
 * <p>为什么要区分「候选数 0」与「状态 null」：前者读作「名册里确实没有这些人」（真·未知 id，
 * 按 `task-111` 的判据就该丢），后者读作「名册**还没回来**」（`sessionParticipants.ts:25` 的
 * `participants === null` = 还没加载）。同一行 warn 若不带这个区分，下一个人看到它仍然不知道
 * 该去查名册请求还是去查 id 拼写 —— 那这条 warn 就只是把静默换成了噪音。</p>
 */
function warnDroppedRecipients(
    field: "to" | "cc",
    dropped: string[],
    candidateCount: number,
): void {
    if (dropped.length === 0) return;
    const roster = participantsStore.participants;
    const state =
        roster === null
            ? "名册尚未加载 participants === null（不是「名册里没这些人」）"
            : `名册已加载：${roster.length} 行 / 可用候选 ${candidateCount} 个`;
    logger.warn(
        `[compose-deeplink] ${field} 丢弃 ${dropped.length} 个 id（${state}）：${dropped.join(", ")}`,
    );
}

/**
 * task-113 A 步：名册**还没到**不是「丢弃」，是「还没轮到」—— 单独一条 warn，别和「名册里没这人」混。
 */
function warnRosterNotReady(field: "to" | "cc", wanted: string[]): void {
    logger.warn(
        `[compose-deeplink] ${field} 暂不写入：名册尚未加载（participants === null）⇒ 保留深链参数，名册到达后重试。目标 ${wanted.length} 个 id：${wanted.join(", ")}`,
    );
}

/**
 * task-113 A 步（BL-339）：单个收件人栏的预填判定 —— **全有或全无**。
 *
 * <p>为什么不按「命中的先填、漏掉的记 warn」：那样会在界面上留下一个「似乎填好了」的状态，
 * 而漏掉的人**不会**因为再等一会儿就出现（retry 时 `current` 非空 ⇒ 只能判"用户已选"）⇒ 用户
 * 看到 2 个 chip 就以为通知了 3 个人。全有或全无 ⇒ 要么如实填满，要么什么都不填。</p>
 *
 * <p>task-126 F3（`dsd-1` 的 task-123）：`blocked` 必须拆两态 —— `blocked`（名册**未到**，可满足 ⇒
 * 保留参数等 retryKey）与 `blocked_unsat`（有 id **不在本会话名册**，不可满足 ⇒ 由调用方消费参数 +
 * 给用户可见提示）。共用一个 `blocked` 时，`blocked` 的唯一出口是 `applied` ⇒ 「不可满足」会让深链
 * 参数**永久滞留 URL**、每次重试刷一条 warn、界面零提示。</p>
 *
 * @returns `applied` 已写入（含「上一次已经写过同样的内容」的重试幂等）；`blocked` 名册未到；
 *          `blocked_unsat` 有 id 不在册（不可满足）；`empty` 载荷里没有可写的 id。
 */
function prefillRecipientField(
    field: "to" | "cc",
    wanted: string[],
    candidates: SessionParticipantView[],
    current: string[],
): { state: "applied" | "blocked" | "blocked_unsat" | "empty"; ids: string[]; unsat: string[] } {
    const allowed = new Set(candidates.map((item) => item.participantId));
    const ids = wanted.filter((id) => allowed.has(id));
    const dropped = wanted.filter((id) => !allowed.has(id));
    if (current.length > 0) {
        const same = current.length === ids.length && ids.every((id) => current.includes(id));
        if (same && dropped.length === 0) return { state: "applied", ids, unsat: [] };
        return { state: dropped.length > 0 ? "blocked_unsat" : "blocked", ids, unsat: dropped };
    }
    if (participantsStore.participants === null) {
        warnRosterNotReady(field, wanted);
        return { state: "blocked", ids, unsat: [] };
    }
    if (dropped.length > 0) {
        warnDroppedRecipients(field, dropped, candidates.length);
        return { state: "blocked_unsat", ids, unsat: dropped };
    }
    return { state: ids.length > 0 ? "applied" : "empty", ids, unsat: [] };
}

/**
 * BL-339：深链预填（不代发）。只填空位、不覆盖用户已有输入与已选收件人，
 * 收件人按本会话候选过滤（未知 id 直接丢弃，不做"猜一个"）。
 * @param next - 预填载荷：正文 + 可选 to/cc（AGENT 参与者 id）。
 * @returns 四态：`applied` 已写入（可清参）；`blocked` 名册未到（**保留参数**，等 retryKey 重试）；
 *          `blocked_unsat` 有 id 不在本会话名册（**不可满足** ⇒ 调用方应消费参数并提示一次）；
 *          `idle` 没有可写内容（**调用方也不得把它当"已消费"**）。
 *
 * <p>task-113 A 步：`participants === null` 与「部分/全部 id 不在册」一律**不写任何收件人**；
 * task-126 F3：两者**出口不同** —— 前者可重试，后者不可满足（清参 + 提示），否则参数永久滞留。</p>
 */
function prefillDraft(next: {
    text: string;
    to?: string[];
    cc?: string[];
}): "applied" | "idle" | "blocked" | "blocked_unsat" {
    let applied = false;
    let blocked = false;
    const unsat: string[] = [];
    if (next.text) {
        if (input.value === next.text) {
            // 重试路径：正文早前已写入，幂等承认，否则 retry 永远卡在「用户已输入」。
            applied = true;
        } else if (input.value.trim()) {
            blocked = true;
        } else {
            input.value = next.text;
            applied = true;
        }
    }
    if (next.to?.length) {
        const outcome = prefillRecipientField(
            "to",
            next.to,
            toTargetCandidates.value,
            toTargetIds.value,
        );
        unsat.push(...outcome.unsat);
        if (outcome.state === "applied") {
            toTargetIds.value = outcome.ids;
            applied = true;
        } else if (outcome.state !== "empty") {
            blocked = true;
        }
    }
    if (next.cc?.length) {
        const outcome = prefillRecipientField("cc", next.cc, ccCandidates.value, ccIds.value);
        unsat.push(...outcome.unsat);
        if (outcome.state === "applied") {
            ccIds.value = outcome.ids;
            for (const id of outcome.ids) ccSuppressed.delete(id);
            applied = true;
        } else if (outcome.state !== "empty") {
            blocked = true;
        }
    }
    if (unsat.length > 0) {
        // 不可满足：**只提示一次** —— 调用方消费参数后不会再进来重试，所以不会每次路由变化都刷。
        unsatRecipients.value = [...new Set(unsat)];
        return "blocked_unsat";
    }
    if (applied) unsatRecipients.value = [];
    if (blocked) return "blocked";
    return applied ? "applied" : "idle";
}

/**
 * task-442（F-14 / D-1276 C1）：把 composer 的**实测高度**发布成 `--xh-composer-h`，
 * 供浮动 dock 把底边让开（`WorkspaceDock.vue` 的 `panelStyle`）。
 *
 * 为什么用 `useElementSize`（`@vueuse/core`，栈内已有依赖）而不是自研 ResizeObserver：
 * 用户裁定「复杂组件优先栈内库」；高度随附件/多行/移动端安全区变化，写死内距是魔数。
 * 发布目标是**最近的 workbench 根**（浮动 dock 的包含块），不是 `:root` —— 避免离开会话面后
 * 留下陈旧值把别的页面的 dock 底边抬高；卸载时显式归零。移动端没有该根 ⇒ 天然 no-op。
 */
const composerRoot = ref<HTMLElement | null>(null);
// border-box：composer 自带 px/pt/pb 内距，content-box 会少算约 16px ⇒ 面板底边仍压住 composer 顶。
const { height: composerHeight } = useElementSize(composerRoot, undefined, {
    box: "border-box",
});
function publishComposerHeight(px: number) {
    const host = composerRoot.value?.closest('[data-testid="workspace-workbench"]');
    if (host instanceof HTMLElement) host.style.setProperty("--xh-composer-h", `${px}px`);
}
watch(composerHeight, (h) => publishComposerHeight(h), { immediate: true });
onBeforeUnmount(() => publishComposerHeight(0));

/**
 * task-113 A 步：名册「已加载 / 还没加载」—— 深链用它当**重试信号**。
 *
 * <p>为什么不由 ChatPanel 自己读 store，或把 ready 改成 Boolean(participants)：名册可能
 * **永远不回来**（无会话 / 403 / 请求失败）⇒ 那样的 ready 会让深链连正文都不预填
 * （task-111 已把这列为「首个错误改法」）。这里只提供信号，何时重试由 composable 决定。</p>
 */
const recipientsReady = computed(() => participantsStore.participants !== null);

defineExpose({ clearDraft, insertMention, setDraft, prefillDraft, recipientsReady });
</script>

<template>
    <!-- BL-328：给 composer 一个稳定锚点，供焦点/Tab 顺序判据使用（原来只能靠 class 猜）。 -->
    <div
        ref="composerRoot"
        class="min-w-0 border-t bg-background px-4 pt-2 pb-[calc(var(--mobile-safe-area-inset-bottom)+0.5rem)]"
        data-testid="chat-composer"
    >
        <div class="mx-auto w-full max-w-4xl space-y-1.5">
            <!--
                D23-27 / PLAN-0630 M5b (D30-14)：`发送`栏（speak-as 升级版）——本次消息的主要响应者
                （单选，默认 = PRIMARY participant）。只有 capabilities.speakAs 为真才**渲染**
                （false 时不渲染，不是禁用）；候选只含我拥有的、未停用的参与者。
                2026-11-04 用户裁定：从原生 select 改为「输入 + 候选浮层」（RecipientField），术语「发送」。
            -->
            <!--
                task-547 F-A：独立会话下这里**没有**「发送」「定向」两栏（见 showSpeakAs/showToTargets），
                但必须**说出来为什么** —— 用户看到少了两个控件而没有任何解释，等于把失败换成了困惑。
            -->
            <p
                v-if="workspaceLess"
                class="px-2 text-xs text-muted-foreground"
                data-testid="composer-workspace-less-hint"
            >
                {{ t("chat.input.workspaceLessNoTargets") }}
            </p>
            <RecipientField
                v-if="showSpeakAs"
                :label="t('chat.input.toLabel')"
                :model-value="effectiveSpeakAsId ? [effectiveSpeakAsId] : []"
                :candidates="speakAsOptions"
                :placeholder="t('chat.input.recipientPlaceholder')"
                testid="speak-as"
                data-testid="speak-as-bar"
                @update:model-value="onSpeakAsFieldChange"
            />
            <!--
                task-114：三栏（代发身份 / 发送 / 抄送）里只有「代发身份」没有栏外说明 ——
                那四个字答不上「本条以谁的账号发出」，读者无从判断该选谁。形态照抄同区
                composer-send-hint / composer-cc-hint（px-2 text-xs text-muted-foreground），
                不另造样式；文案说「做什么」（以谁的账号发出），不解释词义。
                被定向让位时不渲染：那条路径本条不代发，照常说「以所选身份发出」就是假话。
                testid 用 composer- 前缀：RecipientField 自己会渲染 ${testid}-hint
                （键盘提示），裸 speak-as-hint 会与它撞名。
            -->
            <p
                v-if="showSpeakAs && !speakAsOverriddenByTo"
                class="px-2 text-xs text-muted-foreground"
                data-testid="composer-speak-as-hint"
            >
                {{ t("chat.input.toLabelHint") }}
            </p>
            <!-- task-453：默认代发被定向让位时必须说出来，不能只是 chip 悄悄消失。 -->
            <p
                v-if="speakAsOverriddenByTo"
                class="text-muted-foreground"
                data-testid="speak-as-overridden-hint"
            >
                {{ t("chat.input.speakAsOverriddenByTo") }}
            </p>
            <!--
                PLAN-0665 M2（Q3/D4）+ task-88：发送多选（1..N 个参与者，真人也在内）——与上面的
                「代发」栏分开，因为一个消息只能有一个发言身份，但可以有多个响应者。真人目标只收
                「重要通知」、不作答。默认空集 = 旧单响应者路径。
            -->
            <RecipientField
                v-if="showToTargets"
                :label="t('chat.input.toTargetsLabel')"
                :model-value="toTargetIds"
                :candidates="toTargetCandidates"
                :multiple="true"
                :placeholder="t('chat.input.recipientPlaceholder')"
                testid="to-targets"
                data-testid="to-targets-bar"
                @update:model-value="onToTargetsFieldChange"
            />
            <!--
                task-50（用户裁定 P-6）：「发送」= @ 重要通知，「抄送」= 普通通知。
                说明文案必须**贴着各自的栏**，不然用户只看到两个词、不知道差别在哪。
                形态照抄同区 composer-send-hint（px-2 text-xs text-muted-foreground），不另造样式。

                testid 用 composer- 前缀：`RecipientField` 自己会渲染 `${testid}-hint`
                （键盘提示），叫 `cc-hint` 会与它**撞名** —— 实测撞名时断言拿到的是
                「↑↓ 选择 · Enter 确认…」那一段，错的不是产品是选择器。
            -->
            <p
                v-if="showToTargets"
                class="px-2 text-xs text-muted-foreground"
                data-testid="composer-send-hint"
            >
                {{ t("chat.input.toHint") }}
            </p>
            <!--
                task-17（源 = task-6 候选 C-1）：显式空 TO 的**一次性**提示。形态照抄同区
                `composer-send-hint`（`px-2 text-xs text-muted-foreground`）+ 一个可关闭按钮；
                `role="status"` 让读屏播报（`aria-live=polite` 语义），但**不是**错误通道
                （红/警示色一概不上，注意力预算 §10：提示不是危险）。
            -->
            <div
                v-if="showToEmptyHint"
                data-testid="chat-to-empty-hint"
                role="status"
                class="flex items-start gap-2 px-2 text-xs text-muted-foreground"
            >
                <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span class="min-w-0 flex-1 leading-relaxed">{{
                    t("chat.input.toEmptyHint")
                }}</span>
                <button
                    type="button"
                    data-testid="chat-to-empty-hint-dismiss"
                    class="shrink-0 rounded-sm px-1 transition-colors hover:text-foreground"
                    @click="showToEmptyHint = false"
                >
                    {{ t("chat.input.toEmptyHintDismiss") }}
                </button>
            </div>
            <!--
                task-126 F3：深链「不可满足」提示（`blocked_unsat`）。形态照抄上面那条一次性提示
                （同一个区、同一档样式、`role="status"` 不占错误通道）—— 两句话分工：
                第一句说**发生了什么**并点名 id，第二句说**为什么是 id** 与用户该做什么。
            -->
            <div
                v-if="unsatRecipients.length > 0"
                data-testid="compose-deeplink-unsat-hint"
                role="status"
                class="flex items-start gap-2 px-2 text-xs text-muted-foreground"
            >
                <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span class="min-w-0 flex-1 space-y-0.5 leading-relaxed">
                    <span class="block">
                        {{
                            t("chat.input.composeDeeplinkUnsat", {
                                count: unsatRecipients.length,
                                ids: unsatRecipients.join("、"),
                            })
                        }}
                    </span>
                    <span class="block">{{ t("chat.input.composeDeeplinkUnsatWhy") }}</span>
                </span>
                <button
                    type="button"
                    data-testid="compose-deeplink-unsat-dismiss"
                    class="shrink-0 rounded-sm px-1 transition-colors hover:text-foreground"
                    @click="unsatRecipients = []"
                >
                    {{ t("chat.input.toEmptyHintDismiss") }}
                </button>
            </div>
            <!--
                PLAN-0630 M5b (D30-14)：cc 栏 = 旁听名单（多选 chips）。被 @ 的参与者会自动
                出现在这里；点 × 移除（同一个 @ 不再自动加回，直到它从文本里消失）；+ 下拉手动添加。
            -->
            <!--
                2026-11-04 用户裁定（composer 打磨）：抄送栏默认收起为「抄送 +」小按钮，
                自动展开仅两种 —— 已有 chips（含 @ 点名自动加入）、用户手动点开；
                chips 清空后可手动收起，手动选择按会话记忆（不落 localStorage）。
            -->
            <div v-if="showCcSection" class="flex items-center gap-1">
                <button
                    v-if="!ccBarVisible"
                    type="button"
                    data-testid="cc-expand"
                    class="inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    @click="expandCc"
                >
                    <Plus class="size-3" />
                    {{ t("chat.input.ccLabel") }}
                </button>
                <template v-else>
                    <RecipientField
                        class="min-w-0 flex-1"
                        :label="t('chat.input.ccLabel')"
                        :model-value="ccIds"
                        :candidates="ccCandidates"
                        :multiple="true"
                        :placeholder="t('chat.input.recipientPlaceholder')"
                        testid="cc"
                        data-testid="cc-bar"
                        @update:model-value="onCcFieldChange"
                    />
                    <button
                        v-if="ccIds.length === 0"
                        type="button"
                        data-testid="cc-collapse"
                        :aria-label="t('chat.input.ccCollapse')"
                        class="shrink-0 rounded-sm px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                        @click="collapseCc"
                    >
                        ×
                    </button>
                </template>
            </div>
            <p
                v-if="showCcSection && ccBarVisible"
                class="px-2 text-xs text-muted-foreground"
                data-testid="composer-cc-hint"
            >
                {{ t("chat.input.ccHint") }}
            </p>
            <p
                v-if="queueMode"
                class="px-2 text-xs text-muted-foreground"
                role="status"
                data-testid="follow-up-composer-notice"
            >
                {{
                    queueFull
                        ? t("chat.followUpFullNotice")
                        : queuePaused
                          ? t("chat.followUpPausedNotice")
                          : t("chat.followUpComposerNotice")
                }}
            </p>
            <div v-if="attachments.length" class="flex flex-wrap gap-2">
                <div
                    v-for="(file, i) in attachments"
                    :key="file.name + i"
                    class="relative group"
                    data-testid="selected-attachment"
                >
                    <div
                        class="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded border bg-muted/30 text-xs text-muted-foreground"
                        :class="attachmentErrors[file.name] ? 'border-destructive' : ''"
                    >
                        <img
                            v-if="file.type.startsWith('image/')"
                            :src="attachmentObjectUrl(file)"
                            class="w-full h-full object-cover"
                        />
                        <span v-else class="p-1">{{ file.name }}</span>
                        <span
                            v-if="attachmentErrors[file.name]"
                            class="absolute inset-x-0 bottom-0 bg-destructive px-1 py-0.5 text-center text-xs font-medium text-destructive-foreground"
                        >
                            {{ t("multimodal.uploadFailed") }}
                        </span>
                    </div>
                    <button
                        class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-muted text-muted-foreground text-xs flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
                        data-testid="remove-attachment-button"
                        @click="removeAttachment(i)"
                    >
                        ×
                    </button>
                    <div
                        v-if="attachmentErrors[file.name]"
                        data-testid="attachment-upload-error"
                        class="mt-1 w-16 space-y-1 text-xs text-destructive"
                    >
                        <span class="block truncate" :title="attachmentErrors[file.name]">{{
                            t("multimodal.uploadFailed")
                        }}</span>
                        <div class="flex gap-1">
                            <button
                                type="button"
                                data-testid="attachment-retry-button"
                                class="font-medium underline underline-offset-2 hover:no-underline"
                                @click="handleSend"
                            >
                                {{ t("common.retry") }}
                            </button>
                            <button
                                type="button"
                                data-testid="attachment-error-remove-button"
                                class="font-medium underline underline-offset-2 hover:no-underline"
                                @click="removeAttachment(i)"
                            >
                                {{ t("settings.removeServer") }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div class="relative">
                <!--
                    `/help` renders the merged registry locally (server rows + local-only commands).
                    Unavailable rows stay visible, greyed, with their localized reason.
                    role=status so assistive tech announces it without stealing focus.
                -->
                <div
                    v-if="showHelpPanel"
                    class="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-lg border bg-popover p-3 shadow-lg"
                    role="status"
                    data-testid="chat-input-help"
                >
                    <p class="mb-1 text-xs font-medium">{{ t("chat.input.helpTitle") }}</p>
                    <ul class="space-y-1">
                        <li
                            v-for="cmd in slashCommands"
                            :key="cmd.key"
                            class="text-xs"
                            :data-testid="`slash-command-${cmd.key.slice(1)}`"
                        >
                            <span class="font-medium" :class="cmd.disabled ? 'opacity-60' : ''">{{
                                cmd.key
                            }}</span>
                            <span
                                class="ml-2 text-muted-foreground"
                                :class="cmd.disabled ? 'opacity-60' : ''"
                                >{{ t(cmd.descriptionKey) }}</span
                            >
                            <span
                                v-if="cmd.disabled"
                                class="ml-2 text-destructive/80"
                                :data-testid="`slash-command-reason-${cmd.key.slice(1)}`"
                            >
                                {{ t(commandReasonKey(cmd.reason)) }}
                            </span>
                        </li>
                    </ul>
                    <p class="mt-2 text-xs text-muted-foreground">{{ t("chat.input.helpHint") }}</p>
                </div>
                <!--
                    PLAN-0635 M1/M2: one candidate surface for `/`, `@` member and `@` file
                    (D35-01) — a single listbox means the keyboard/aria contract cannot drift.
                    M2 adds the file group **inside** this listbox (group headings only).
                -->
                <div
                    v-if="menuOpen"
                    :id="TRIGGER_MENU_ID"
                    class="absolute bottom-full left-0 mb-2 max-h-72 w-72 overflow-y-auto rounded-lg border bg-popover shadow-lg"
                    role="listbox"
                    :aria-label="
                        triggerKind === 'mention'
                            ? t('chat.input.mentionsTitle')
                            : t('chat.input.commandsTitle')
                    "
                    data-testid="chat-input-trigger-menu"
                >
                    <template v-for="group in menuGroups" :key="group.id">
                        <div
                            class="border-b bg-muted/40 px-2 py-1 text-xs font-medium text-muted-foreground"
                            role="presentation"
                            :data-testid="`chat-input-group-${group.id}`"
                        >
                            {{ t(group.titleKey) }}
                        </div>
                        <button
                            v-for="item in group.items"
                            :id="item.id"
                            :key="item.id"
                            role="option"
                            :aria-selected="item.flatIndex === triggerIndex"
                            :aria-disabled="item.disabled ? 'true' : undefined"
                            class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                            :class="[
                                item.flatIndex === triggerIndex ? 'bg-accent' : '',
                                item.disabled ? 'opacity-50' : '',
                            ]"
                            @mousedown.prevent
                            @click="pickItem(item.flatIndex)"
                        >
                            <span class="truncate font-medium">{{ item.label }}</span>
                            <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{
                                item.hint
                            }}</span>
                        </button>
                        <DelegationDialog
                            v-model:open="delegationOpen"
                            :session-id="sessionId"
                            :principals="delegationPrincipals"
                            :budget="delegationBudget"
                            :submitting="delegationSubmitting"
                            :approval-pending="pendingApprovalRequestId !== null"
                            @submit="handleDelegationSubmit"
                        />
                    </template>
                </div>
            </div>

            <!--
                task-30 ①（用户报障「输入框有一圈黑框」）：焦点环形态修的是**宽度与透明度**，不是删掉可见性
                （DEV-011 §10：focus 必须环形轮廓且与 hover 可区分）。

                为什么黑：`--ring: var(--primary)`（`themes/color-shadcn-*.css:40`，近黑），旧值
                `ring-1 + ring-ring/60` ⇒ 1px、60% 的近黑硬框；本仓**控件族**的标准是
                `ring-3 + ring-ring/50`（Button / Tabs / Switch / Checkbox / Select / Slider / Accordion /
                RadioGroup / Badge / Toggle / ScrollArea 共 13 个文件，实测 `git grep "focus-visible:ring-3"`），
                这里原来是孤例。3px / 50% 在同一 token 下是柔和光圈，不再是硬边。

                为什么不直接换 vendor `Textarea`（本仓规矩：能由库满足的交互不得自研）：实测
                `components/ui/textarea/Textarea.vue:28` 的基类自带 `border`、`rounded-lg`、`px-2.5 py-2`、
                `min-h-16`、`text-base`，且**没有 focus 环**（只有 `aria-invalid:ring-3`）⇒ 换过去要覆盖
                6 条基类才能贴合 composer 的「容器即字段」形态（容器已有 border + rounded-lg），
                并且会**丢掉焦点可见性**。所以这里保留原生 textarea，只把环的形态对齐控件族标准。

                双框处置：**保留外层容器 border，环画在 textarea 自己身上**。容器 12px 内距 > 3px 环宽
                ⇒ 环住在内距里、不压容器边框；换成「把环画到容器上」会让点工具栏按钮时整块输入区发光，
                去掉容器 border 则失焦后没有字段边界 —— 两者都比现状差。

                补充（task-39）：本行 `focus:outline-none` 一度是**哑弹** —— 全局 `*:focus-visible` 当时
                写在 `@layer` 之外，压过所有 utility，于是焦点态是「2px 纯黑 outline + 自己的环」。
                task-39 已把那条全局规则搬进 `@layer base`，utility 恢复生效，这里不再需要 `!`。
                （`!` 版本在 task-30 提交里用过；根因修掉后留在代码里会让下一个读注释的人以为还得加 `!`。）
            -->
            <div class="rounded-lg border bg-muted/30 px-3 py-2">
                <textarea
                    ref="textareaRef"
                    v-model="input"
                    data-testid="chat-input"
                    class="w-full min-h-[36px] max-h-[180px] px-1 py-0.5 bg-transparent resize-none text-sm leading-relaxed placeholder:text-xs placeholder:text-muted-foreground/70 focus:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-0 field-sizing-content"
                    :placeholder="queueMode ? t('chat.followUpPlaceholder') : t('chat.placeholder')"
                    rows="1"
                    :style="{ fieldSizing: 'content' }"
                    :aria-expanded="menuOpen"
                    :aria-controls="menuOpen ? TRIGGER_MENU_ID : undefined"
                    :aria-activedescendant="menuOpen && activeItemId ? activeItemId : undefined"
                    :aria-autocomplete="menuOpen ? 'list' : undefined"
                    @compositionstart="isComposing = true"
                    @compositionend="isComposing = false"
                    @keydown="handleKeydown"
                    @input="handleInput"
                />
                <div class="flex min-w-0 items-center gap-2">
                    <InputToolbar :actions="toolbarActions" />
                    <LoaderCircle
                        v-if="isUploading"
                        data-testid="attachment-uploading-indicator"
                        class="size-4 shrink-0 animate-spin text-muted-foreground"
                    />
                    <button
                        v-if="queueMode"
                        type="button"
                        data-testid="chat-queue-button"
                        :aria-label="t('chat.followUpEnqueue')"
                        :disabled="
                            sendDisabled || isUploading || queueSubmitting || queueActionBusy
                        "
                        class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        :class="
                            queuePaused
                                ? 'border border-border bg-background text-foreground hover:bg-accent'
                                : 'bg-primary text-primary-foreground hover:opacity-90'
                        "
                        @click="handleSend"
                    >
                        <LoaderCircle v-if="queueSubmitting" class="size-3.5 animate-spin" />
                        <Send v-else class="size-3.5" />
                        <span>{{
                            queueSubmitting
                                ? t("chat.followUpEnqueuing")
                                : t("chat.followUpEnqueue")
                        }}</span>
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
