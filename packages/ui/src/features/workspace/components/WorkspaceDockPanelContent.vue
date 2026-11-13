<script setup lang="ts">
import FileEditor from "./FileEditor.vue";
import WorkspaceChangesPanel from "./WorkspaceChangesPanel.vue";
import SessionMonitorPanel from "../monitor/SessionMonitorPanel.vue";
import SessionParticipantsPanel from "./SessionParticipantsPanel.vue";
import SessionContextPanel from "./SessionContextPanel.vue";
import DelegationDagPanel from "../chat/components/DelegationDagPanel.vue";
import WorkspaceAgentsPanel from "./WorkspaceAgentsPanel.vue";
import { useI18n } from "vue-i18n";

/**
 * task-369 S1：dock 七个面板的**内容**，从 `WorkspaceWorkbench` 的 slot 体里抽出来，
 * 让手写 dock（`WorkspaceDock` 的具名 slot）与 dockview 壳（`WorkspaceShellDockview`
 * 的 `panel-<id>` slot）**共用同一份**，避免两条渲染路径各写一遍而漂移。
 * 只搬位置，不改内容：每个分支的 props / emits / 空态与搬迁前逐字相同。
 */
defineProps<{
    id: string;
    sessionId: string | null;
    workspaceId: string;
}>();

const emit = defineEmits<{
    close: [];
    mention: [name: string];
}>();

const { t } = useI18n();
</script>

<template>
    <FileEditor v-if="id === 'code'" />
    <WorkspaceChangesPanel
        v-else-if="id === 'changes'"
        :session-id="sessionId"
        :workspace-id="workspaceId"
        @close="emit('close')"
    />
    <template v-else-if="id === 'monitor'">
        <SessionMonitorPanel v-if="sessionId" :session-id="sessionId" />
        <div v-else class="p-4 text-xs text-muted-foreground">
            {{ t("workspace.noSession") }}
        </div>
    </template>
    <SessionParticipantsPanel
        v-else-if="id === 'members'"
        :session-id="sessionId ?? null"
        @mention="emit('mention', $event)"
    />
    <SessionContextPanel v-else-if="id === 'context'" :session-id="sessionId ?? null" />
    <template v-else-if="id === 'delegation'">
        <DelegationDagPanel v-if="sessionId" :session-id="sessionId" />
        <div v-else class="p-4 text-xs text-muted-foreground">
            {{ t("workspace.noSession") }}
        </div>
    </template>
    <WorkspaceAgentsPanel
        v-else-if="id === 'agents'"
        :key="workspaceId"
        :workspace-id="workspaceId"
    />
</template>
