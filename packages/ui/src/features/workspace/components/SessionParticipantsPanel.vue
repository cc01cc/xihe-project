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
const error = ref("");
const removingId = ref<string | null>(null);

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
    try {
        const response = await api.getSessionParticipants(props.sessionId);
        participants.value = response.participants;
        capabilities.value = response.capabilities;
    } catch (cause) {
        // 契约破了 / 网络断了都必须显式失败；不要用空列表掩盖。
        participants.value = null;
        capabilities.value = { view: false, manage: false, mention: false };
        error.value = cause instanceof ApiError ? cause.message : String(cause);
    } finally {
        loading.value = false;
    }
}

watch(() => props.sessionId, load, { immediate: true });

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
            {{ t("workspace.participantsEmpty") }}
        </p>
        <p v-else-if="loading" class="text-muted-foreground" data-testid="participants-loading">
            {{ t("workspace.participantsLoading") }}
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
        <p v-else-if="!canView" class="text-muted-foreground" data-testid="participants-forbidden">
            {{ t("workspace.participantsForbidden") }}
        </p>
        <p
            v-else-if="(participants?.length ?? 0) === 0"
            class="text-muted-foreground"
            data-testid="participants-empty"
        >
            {{ t("workspace.participantsEmpty") }}
        </p>
        <ul v-else class="space-y-1.5" data-testid="participants-list">
            <ParticipantRow
                v-for="participant in participants ?? []"
                :key="participant.participantId"
                :participant="participant"
                :can-manage="capabilities.manage"
                :can-mention="capabilities.mention"
                :removing="removingId === participant.participantId"
                @remove="removeParticipant"
            />
        </ul>
    </div>
</template>
