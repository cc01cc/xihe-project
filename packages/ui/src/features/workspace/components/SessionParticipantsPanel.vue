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
import { ApiError, PARTICIPANT_CURSOR_ADVANCE_TO_LATEST, api } from "../../../composables/api";
import ParticipantRow from "./ParticipantRow.vue";
import { useSessionParticipantsStore } from "../stores/sessionParticipants";
import type {
    ParticipantRespondPolicy,
    ParticipantWakePolicy,
    SessionParticipantView,
} from "../../../types/participant";

const props = defineProps<{
    /** null = 当前没有打开的会话（与 monitor tab 同构）。 */
    sessionId: string | null;
}>();

const { t } = useI18n();

/**
 * 单一数据源：dock 面板与 composer 的「代发」下拉共用 `useSessionParticipantsStore`，
 * 避免两份 `GET` 各自过期（症状：面板有某行、下拉里没有它）。
 */
const store = useSessionParticipantsStore();
const participants = computed(() => store.participants);
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
                    :removing="removingId === participant.participantId"
                    :saving="savingId === participant.participantId"
                    :advancing="advancingId === participant.participantId"
                    @remove="removeParticipant"
                    @mention="emit('mention', $event)"
                    @policy="updatePolicy"
                    @advance-cursor="advanceCursor"
                />
            </ul>
        </template>
    </div>
</template>
