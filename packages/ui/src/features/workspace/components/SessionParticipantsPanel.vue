<script setup lang="ts">
/**
 * PLAN-0623 U1：会话参与者面板（dock tab `members`）。
 *
 * 范围（本里程碑）：**面板骨架 + 空态**。参与者数据依赖 CP `task-59` 的
 * participants 契约（字段/端点/capability 键名），在那之前：
 * - 不发起任何网络请求（避免"按想象写"）；
 * - 有会话时显示占位，明确说明"契约就绪后接入"而不是伪造空列表。
 *
 * 与 `WorkspaceMembersPanel`（工作区成员，PLAN-0565）**是两个域**，不得互相复用。
 */
import { useI18n } from "vue-i18n";

const props = defineProps<{
    /** null = 当前没有打开的会话（与 monitor tab 同构：无会话时显示空态）。 */
    sessionId: string | null;
}>();

const { t } = useI18n();
</script>

<template>
    <div class="p-4 text-xs" data-testid="session-participants-panel">
        <p v-if="!props.sessionId" class="text-muted-foreground" data-testid="participants-empty">
            {{ t("workspace.participantsEmpty") }}
        </p>
        <!-- CP 契约（participants 端点/字段/capability）就绪后，这里替换为参与者列表。 -->
        <p v-else class="text-muted-foreground" data-testid="participants-pending">
            {{ t("workspace.participantsPending") }}
        </p>
    </div>
</template>
