<script setup lang="ts">
/**
 * PLAN-0623 U1：会话参与者面板（dock tab `members`）。
 *
 * 数据来自 CP `GET /api/v1/sessions/{id}/participants`（M0 契约已定，M1a 实装）。
 * 在数据源接线前，`participants` 为 `null` ⇒ **什么都不渲染**：
 * - 不伪造空列表（`[]` 与"还不知道"是两件事）；
 * - 不显示"暂无参与者"这种既成事实的措辞。
 *
 * 与 `WorkspaceMembersPanel`（工作区成员，PLAN-0565）**是两个域**，不得互相复用。
 */
import { useI18n } from "vue-i18n";
import ParticipantRow from "./ParticipantRow.vue";
import type { SessionParticipantView } from "../../../types/participant";

const props = defineProps<{
    /** null = 当前没有打开的会话（与 monitor tab 同构：无会话时显示空态）。 */
    sessionId: string | null;
    /** null/undefined = 数据源尚未接线（必须区别于空数组）。 */
    participants?: SessionParticipantView[] | null;
}>();

const { t } = useI18n();
</script>

<template>
    <div class="p-3 text-xs" data-testid="session-participants-panel">
        <p v-if="!props.sessionId" class="text-muted-foreground" data-testid="participants-empty">
            {{ t("workspace.participantsEmpty") }}
        </p>
        <!-- 数据源未接线：保持空白，不渲染任何"看起来像结论"的文案。 -->
        <template v-else-if="props.participants === null || props.participants === undefined" />
        <p
            v-else-if="props.participants.length === 0"
            class="text-muted-foreground"
            data-testid="participants-empty"
        >
            {{ t("workspace.participantsEmpty") }}
        </p>
        <ul v-else class="space-y-1.5" data-testid="participants-list">
            <ParticipantRow
                v-for="participant in props.participants"
                :key="participant.participantId"
                :participant="participant"
            />
        </ul>
    </div>
</template>
