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
import { ApiError, api } from "../../../composables/api";
import ParticipantRow from "./ParticipantRow.vue";
import type {
    ParticipantRespondPolicy,
    ParticipantWakePolicy,
    SessionParticipantCapabilities,
    SessionParticipantView,
} from "../../../types/participant";

const props = defineProps<{
    /** null = 当前没有打开的会话（与 monitor tab 同构）。 */
    sessionId: string | null;
}>();

const { t } = useI18n();

const participants = ref<SessionParticipantView[] | null>(null);
const capabilities = ref<SessionParticipantCapabilities>({
    view: false,
    manage: false,
    mention: false,
});
const loading = ref(false);
/** T3.7：403 单独成态（不渲染行、不显示空态文案）。 */
const forbidden = ref(false);
const error = ref("");
/** 改策略/移除的失败：留在列表内提示，不摧毁列表。 */
const policyError = ref("");
const removingId = ref<string | null>(null);
const savingId = ref<string | null>(null);

const emit = defineEmits<{
    /** `@` 提及：把 `@displayName` 插到输入框（发送路径由父级接线，面板不发消息）。 */
    mention: [name: string];
}>();

const canView = computed(() => capabilities.value.view);

async function load(): Promise<void> {
    if (!props.sessionId) {
        participants.value = null;
        loading.value = false;
        error.value = "";
        return;
    }
    loading.value = true;
    error.value = "";
    forbidden.value = false;
    try {
        const response = await api.getSessionParticipants(props.sessionId);
        participants.value = response.participants;
        capabilities.value = response.capabilities;
    } catch (cause) {
        // 契约破了 / 网络断了都必须显式失败；不要用空列表掩盖。
        participants.value = null;
        capabilities.value = { view: false, manage: false, mention: false };
        // T3.7：`403` 是"没有权限"，必须与"空列表"和"加载失败"分开呈现。
        forbidden.value = cause instanceof ApiError && cause.problem.status === 403;
        // 403 只进 forbidden 态：不能再落 error，否则会被错误页盖住。
        if (!forbidden.value)
            error.value = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
        loading.value = false;
    }
}

watch(() => props.sessionId, load, { immediate: true });

/** 改策略：只带变更字段；失败时**不改本地值**（旧值保留），并显示本地化提示。 */
async function updatePolicy(
    participant: SessionParticipantView,
    change: { wakePolicy?: ParticipantWakePolicy; respondPolicy?: ParticipantRespondPolicy },
): Promise<void> {
    if (!props.sessionId || !capabilities.value.manage || savingId.value) return;
    savingId.value = participant.participantId;
    policyError.value = "";
    try {
        await api.updateSessionParticipant(props.sessionId, participant.participantId, change);
        await load();
    } catch (cause) {
        // PRIMARY 不可改 / 其它 4xx：显示本地化提示，行内下拉仍显示旧值（props 未变）。
        policyError.value = policyErrorMessage(cause);
    } finally {
        savingId.value = null;
    }
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
    error.value = "";
    try {
        await api.removeSessionParticipant(props.sessionId, participant.participantId);
        await load();
    } catch (cause) {
        error.value = cause instanceof ApiError ? cause.message : String(cause);
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
            <!-- 改策略失败：**留在列表里**提示，不把整个列表换成错误页（否则用户看不到旧值）。 -->
            <p
                v-if="policyError"
                class="mb-2 break-all text-destructive"
                data-testid="participants-error-detail"
            >
                {{ policyError }}
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
                    @remove="removeParticipant"
                    @mention="emit('mention', $event)"
                    @policy="updatePolicy"
                />
            </ul>
        </template>
    </div>
</template>
