<script setup lang="ts">
/**
 * PLAN-0623：会话参与者面板（dock tab `members`）。
 *
 * 数据来自 CP `GET /api/v1/sessions/{id}/participants`（M1a）：
 * `{ participants: [...], capabilities: { view, manage, mention } }`。
 *
 * 状态语义（刻意区分"没有"与"不知道"，N3）：
 * - 无会话 → `participants-empty`；
 * - 加载中 → `participants-loading`（不显示"没有参与者"）；
 * - 加载失败 → `participants-error` + 重试（**不**退化成空列表）；
 * - `capabilities.view === false` → `participants-forbidden`（不渲染行）；
 * - 真实空数组 → `participants-empty`；
 * - 有数据 → 行列表。
 *
 * D23-26：移除是 **soft disable** —— 删除成功后重新拉取，行仍在（带「已停用」徽标），
 * 不会凭空消失。
 *
 * 与 `WorkspaceMembersPanel`（工作区成员，PLAN-0565）**是两个域**，不得互相复用。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { MessageCircleQuestion } from "@lucide/vue";
import {
    ApiError,
    PARTICIPANT_CURSOR_ADVANCE_TO_LATEST,
    api,
    type WorkspaceAgentBinding,
} from "../../../composables/api";
import { readTabWorkspaceId } from "../../../lib/workspaceContext";
import { logger } from "../../../lib/logger";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import ParticipantRow from "./ParticipantRow.vue";
import { useSessionParticipantsStore } from "../stores/sessionParticipants";
import { useUserQuestionsStore } from "../stores/userQuestions";
import { useAuthStore } from "../../../stores/auth";
import type {
    ParticipantRespondPolicy,
    ParticipantWakePolicy,
    SessionParticipantView,
} from "../../../types/participant";

const props = withDefaults(
    defineProps<{
        /** null = 当前没有打开的会话（与 monitor tab 同构）。 */
        sessionId: string | null;
        /**
         * BL-317b：行密度透传（`summary` = 移动端成员 sheet 的默认，策略/模型/移除收进展开区）。
         * 缺省 `full`，桌面与既有调用方行为不变。
         */
        density?: "full" | "summary";
    }>(),
    { density: "full" },
);

const { t } = useI18n();

/**
 * 单一数据源：dock 面板与 composer 的「代发」下拉共用 `useSessionParticipantsStore`，
 * 避免两份 `GET` 各自过期（症状：面板有某行、下拉里没有它）。
 */
const store = useSessionParticipantsStore();
/**
 * BL-317：工作区写能力（既有投影 `auth.canWriteWorkspace`，CP `WorkspaceView.canWrite`）。
 * VIEWER 的「标记已读」必须在**点击前**禁用 —— 否则点击必然 403 `WORKSPACE_READ_ONLY`。
 * 判定源沿用既有投影，不新增能力位、也不按角色名特判（与 `SessionPolicyControls` 同源）。
 */
const authStore = useAuthStore();
const canWriteWorkspace = computed(() => authStore.canWriteWorkspace);
const participants = computed(() => store.participants);

/**
 * PLAN-0660 T5.21（审计 P1-2 / 用户 2026-11-07 裁定 ③）：「N 条待答」**面板级汇总**徽标。
 *
 * 为什么不是行内徽标：`ParticipantRow` 的 `@N` 是**该参与者**的 CP 派生未读游标
 * （`readCursor.mentionCount`，per-participant），而 ask_user 待答是**用户级**投影
 * （`GET /api/v1/user-questions`，无 workspace 上下文、无 `X-Workspace-Id`）—— 两个维度。
 * 把 `pendingCount` 塞进每一行会让所有行显示同一个全局数字、并让 title 文案撒谎。
 *
 * 所以「与问题卡同源」落在这里：**同一 store、同一服务端派生值**（`useUserQuestionsStore`，
 * 与侧边栏 `UserQuestionsEntry` 徽标完全同源；T5.19 纪律：不在本地累加，重连/多标签页才对得上）。
 * 视觉权重按 DEV-011 §10 注意力预算取 **L2 中性**（`bg-muted`/`text-muted-foreground`），
 * 不与行内 `bg-primary` 未读徽标抢焦点；`0` 时不渲染，与行内「缺失即不渲染」一致。
 */
const userQuestionsStore = useUserQuestionsStore();
const pendingQuestionCount = computed(() => userQuestionsStore.pendingCount);
const capabilities = computed(() => store.capabilities);
const loading = computed(() => store.loading);
const forbidden = computed(() => store.forbidden);
const error = computed(() => store.error);

/**
 * 行内动作（改策略 / 移除 / 推进已读游标）的失败：留在列表内提示，不摧毁列表：
 * 一旦换成错误页，用户就看不到自己刚操作的那一行的旧值了。
 */
const actionError = ref("");

/** store 的 load 由 sessionId 变化驱动（面板与 composer 共用同一份数据）。 */
watch(() => props.sessionId, load, { immediate: true });
const removingId = ref<string | null>(null);
const savingId = ref<string | null>(null);
/** PLAN-0660 T5.6：游标 PATCH 在途的行（避免重复提交）。 */
const advancingId = ref<string | null>(null);

const emit = defineEmits<{
    /** `@` 提及：把 `@displayName` 插到输入框（发送路径由父级接线，面板不发消息）。 */
    mention: [name: string];
}>();

const canView = computed(() => capabilities.value.view);

/**
 * task-452（F-15 / Lead 裁 P1）：把**已绑本工作区的智能体**加入会话名册。
 *
 * 为什么必须有这个入口：composer 的定向/抄送候选只来自 `SessionParticipantView[]`（会话名册），
 * 名册此前只能由 CP 侧写入 ⇒ 工作区里绑好的第二个智能体**永远搜不到、发不出去**，
 * 多智能体协作堵在第一步（授权门通过 ≠ 路径能走通，与 F-09/F-11 同族）。
 * 后端能力早就有：`POST /api/v1/sessions/{id}/participants`（201，重放 409）。
 *
 * 能力门沿用面板既有的 `capabilities.manage`（CP 派生），**不按角色名特判**。
 */
const workspaceAgents = ref<WorkspaceAgentBinding[]>([]);
const addSelection = ref("");
const adding = ref(false);
const addError = ref("");

const addCandidates = computed(() => {
    const inRoster = new Set(
        (participants.value ?? [])
            .filter((item) => item.principalKind === "AGENT")
            .map((item) => item.principalId),
    );
    // 已在名册的（含被软停用的行）不重复提供；未绑定/已停用的主体不能用于新会话。
    return workspaceAgents.value.filter(
        (agent) => agent.bound && !agent.disabled && !inRoster.has(agent.principalId),
    );
});

const canAddParticipants = computed(
    () =>
        Boolean(props.sessionId) && !loading.value && !forbidden.value && capabilities.value.manage,
);

async function loadWorkspaceAgents(): Promise<void> {
    const workspaceId = readTabWorkspaceId();
    if (!workspaceId) {
        workspaceAgents.value = [];
        return;
    }
    try {
        workspaceAgents.value = (await api.getWorkspaceAgents(workspaceId)) ?? [];
    } catch (error) {
        // 候选拉取失败不摧毁名册：入口降级为空候选 + 行内提示，已有行照常可操作。
        logger.warn("session participants: load workspace agents failed", error);
        workspaceAgents.value = [];
    }
}

async function addAgentParticipant(): Promise<void> {
    if (!props.sessionId || !addSelection.value || adding.value || !capabilities.value.manage)
        return;
    adding.value = true;
    addError.value = "";
    try {
        await api.addSessionParticipant(
            props.sessionId,
            { principalKind: "AGENT", principalId: addSelection.value },
            readTabWorkspaceId() ?? undefined,
        );
        addSelection.value = "";
        await store.load(props.sessionId);
        await loadWorkspaceAgents();
    } catch (error) {
        addError.value =
            error instanceof ApiError && error.problem?.code === "PARTICIPANT_ALREADY_EXISTS"
                ? t("workspace.participantAddExists")
                : t("workspace.participantAddFailed");
    } finally {
        adding.value = false;
    }
}

watch(
    () => [props.sessionId, capabilities.value.manage] as const,
    ([id, manage]) => {
        addSelection.value = "";
        addError.value = "";
        if (id && manage) void loadWorkspaceAgents();
    },
    { immediate: true },
);

async function load(): Promise<void> {
    await store.load(props.sessionId);
}

/** 改策略：只带变更字段；失败时**不改本地值**（旧值保留），并显示本地化提示。 */
async function updatePolicy(
    participant: SessionParticipantView,
    change: { wakePolicy?: ParticipantWakePolicy; respondPolicy?: ParticipantRespondPolicy },
): Promise<void> {
    if (!props.sessionId || !capabilities.value.manage || savingId.value) return;
    savingId.value = participant.participantId;
    actionError.value = "";
    try {
        await api.updateSessionParticipant(props.sessionId, participant.participantId, change);
        await store.reload();
    } catch (cause) {
        // PRIMARY 不可改 / 其它 4xx：显示本地化提示，行内下拉仍显示旧值（props 未变）。
        actionError.value = policyErrorMessage(cause);
    } finally {
        savingId.value = null;
    }
}

/**
 * PLAN-0660 T5.6：把**本人**的已读游标推进到服务端允许的最新位置。
 *
 * 上限不在这里算：请求带 `PARTICIPANT_CURSOR_ADVANCE_TO_LATEST`，CP 负责 advance-only + 夹取
 * 到会话最大 sequence；成功后**直接采用响应里的 `readCursor`**（不再额外 `reload()`）——
 * 徽标立刻归零，且不会因为一次点击重拉整份名单。失败只用本地化文案提示，行内数据保持原样。
 */
async function advanceCursor(participant: SessionParticipantView): Promise<void> {
    if (!props.sessionId || advancingId.value) return;
    advancingId.value = participant.participantId;
    actionError.value = "";
    try {
        const cursor = await api.advanceParticipantCursor(
            props.sessionId,
            participant.participantId,
            PARTICIPANT_CURSOR_ADVANCE_TO_LATEST,
        );
        store.applyCursor(participant.participantId, cursor);
    } catch (cause) {
        // `403 CURSOR_SELF_ONLY`（行不属于调用者）必须可读；其它失败给通用提示，不直显英文 detail。
        actionError.value = cursorErrorMessage(cause);
    } finally {
        advancingId.value = null;
    }
}

/** CP 错误码 → 本地化文案（游标推进）。 */
function cursorErrorMessage(cause: unknown): string {
    const code = cause instanceof ApiError ? cause.problem.code : "";
    if (code === "CURSOR_SELF_ONLY") return t("workspace.participantCursorSelfOnly");
    return t("workspace.participantCursorAdvanceFailed");
}

/** CP 错误码 → 本地化提示；不直显英文 detail。 */
function policyErrorMessage(cause: unknown): string {
    const code = cause instanceof ApiError ? cause.problem.code : "";
    if (code === "PARTICIPANT_PRIMARY_IMMUTABLE") {
        return t("workspace.participantPrimaryImmutable");
    }
    if (code === "PARTICIPANT_CAP_DENIED") {
        return t("workspace.participantManageDenied");
    }
    return cause instanceof ApiError ? cause.message : String(cause);
}

/** D23-26：soft disable 之后重新拉取，让行带着「已停用」徽标继续存在。 */
async function removeParticipant(participant: SessionParticipantView): Promise<void> {
    if (!props.sessionId || !capabilities.value.manage || removingId.value) return;
    removingId.value = participant.participantId;
    actionError.value = "";
    try {
        await api.removeSessionParticipant(props.sessionId, participant.participantId);
        await store.reload();
    } catch (cause) {
        // 移除失败同样留在列表里提示，不把列表换成错误页。
        actionError.value = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
        removingId.value = null;
    }
}
</script>

<template>
    <div class="p-3 text-xs" data-testid="session-participants-panel">
        <!--
            PLAN-0660 T5.21（用户裁定 ③）：面板级「N 条待答」汇总，与侧边栏问题卡入口同一
            store/同一服务端值。0 时不渲染（与行内未读徽标「缺失即不渲染」一致）。
        -->
        <p
            v-if="props.sessionId && pendingQuestionCount > 0"
            class="mb-2 flex items-center gap-1.5"
            data-testid="participants-pending-questions"
        >
            <MessageCircleQuestion
                class="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
            />
            <span
                class="rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none tabular-nums text-muted-foreground"
                data-testid="participants-pending-questions-badge"
                :title="t('userQuestions.title')"
                >{{ t("userQuestions.pendingCount", { count: pendingQuestionCount }) }}</span
            >
        </p>
        <!--
            task-452（F-15）：名册添加入口。放在状态分支**之前**，空名册时也能加人
            （空名册恰恰是最需要它的时候）。能力门 = CP 派生的 capabilities.manage。
        -->
        <div
            v-if="canAddParticipants"
            class="mb-2 flex items-center gap-1.5"
            data-testid="participants-add-agent"
        >
            <Select v-model="addSelection">
                <SelectTrigger
                    class="h-7 flex-1 text-xs"
                    data-testid="participants-add-agent-select"
                    :aria-label="t('workspace.participantAddLabel')"
                >
                    <SelectValue :placeholder="t('workspace.participantAddPlaceholder')" />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem
                        v-for="agent in addCandidates"
                        :key="agent.principalId"
                        :value="agent.principalId"
                        :data-testid="`participants-add-option-${agent.principalId}`"
                    >
                        {{ agent.name }}
                    </SelectItem>
                </SelectContent>
            </Select>
            <Button
                size="sm"
                variant="outline"
                class="h-7 shrink-0 text-xs"
                data-testid="participants-add-agent-submit"
                :disabled="!addSelection || adding"
                @click="addAgentParticipant"
            >
                {{ t("workspace.participantAddAction") }}
            </Button>
        </div>
        <p
            v-if="canAddParticipants && addCandidates.length === 0"
            class="mb-2 text-muted-foreground"
            data-testid="participants-add-empty"
        >
            {{ t("workspace.participantAddNone") }}
        </p>
        <p
            v-if="addError"
            class="mb-2 break-all text-destructive"
            data-testid="participants-add-error"
        >
            {{ addError }}
        </p>
        <p v-if="!props.sessionId" class="text-muted-foreground" data-testid="participants-empty">
            {{ t("workspace.participantsEmptyNoSession") }}
        </p>
        <p v-else-if="loading" class="text-muted-foreground" data-testid="participants-loading">
            {{ t("workspace.participantsLoading") }}
        </p>
        <!-- T3.7：403 / view=false 是"没有权限"，与"加载失败"、"空列表"分属三种状态。 -->
        <p
            v-else-if="!error && (forbidden || !canView)"
            class="text-muted-foreground"
            data-testid="participants-forbidden"
        >
            {{ t("workspace.participantsForbidden") }}
        </p>
        <div v-else-if="error" data-testid="participants-error">
            <p class="text-destructive">{{ t("workspace.participantsLoadFailed") }}</p>
            <p class="mt-1 break-all text-muted-foreground" data-testid="participants-error-detail">
                {{ error }}
            </p>
            <button
                type="button"
                class="mt-2 rounded border px-2 py-0.5"
                data-testid="participants-retry"
                @click="load()"
            >
                {{ t("common.retry") }}
            </button>
        </div>
        <p
            v-else-if="(participants?.length ?? 0) === 0"
            class="text-muted-foreground"
            data-testid="participants-empty"
        >
            {{ t("workspace.participantsEmptyNone") }}
        </p>
        <template v-else>
            <!-- 行内动作失败：**留在列表里**提示，不把整个列表换成错误页（否则用户看不到旧值）。 -->
            <p
                v-if="actionError"
                class="mb-2 break-all text-destructive"
                data-testid="participants-error-detail"
            >
                {{ actionError }}
            </p>
            <ul class="space-y-1.5" data-testid="participants-list">
                <ParticipantRow
                    v-for="participant in participants ?? []"
                    :key="participant.participantId"
                    :participant="participant"
                    :can-manage="capabilities.manage"
                    :can-mention="capabilities.mention"
                    :can-write="canWriteWorkspace"
                    :removing="removingId === participant.participantId"
                    :saving="savingId === participant.participantId"
                    :advancing="advancingId === participant.participantId"
                    :density="density"
                    @remove="removeParticipant"
                    @mention="emit('mention', $event)"
                    @policy="updatePolicy"
                    @advance-cursor="advanceCursor"
                />
            </ul>
        </template>
    </div>
</template>
