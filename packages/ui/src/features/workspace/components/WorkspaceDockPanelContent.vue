<script setup lang="ts">
import FileEditor from "./FileEditor.vue";
import FileTreePanel from "./FileTreePanel.vue";
import WorkspaceChangesPanel from "./WorkspaceChangesPanel.vue";
import SessionMonitorPanel from "../monitor/SessionMonitorPanel.vue";
import SessionParticipantsPanel from "./SessionParticipantsPanel.vue";
import SessionContextPanel from "./SessionContextPanel.vue";
import DelegationDagPanel from "../chat/components/DelegationDagPanel.vue";
import WorkspaceAgentsPanel from "./WorkspaceAgentsPanel.vue";
import { useI18n } from "vue-i18n";
import { SESSION_CONFIG_VIEW, paneTabSessionId, paneTabView } from "../lib/panelTabs";

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
    /**
     * task-44：深链 `?agent=<principalId>` 的目标主体。只对 `agents` 分支有意义 ——
     * 中间层只透传，不解释（解释放在面板与宿主各一处就够，多一层就多一处会漂的规则）。
     */
    agentId?: string | null;
}>();

const emit = defineEmits<{
    close: [];
    mention: [name: string];
    /**
     * task-144 ②：`files` 面板的折叠动作归宿主（`treeCollapsed` 的唯一 writer 在 Workbench）。
     * 本组件只上报「用户按了树面板的折叠」，不自己写布局 —— 与 `close` / `mention` 同一条纪律。
     */
    collapseTree: [];
}>();

const { t } = useI18n();
</script>

<template>
    <!--
        task-144 ②（P1）：**`files` 必须有分支**。`DOCK_PANEL_IDS = DOCK_TAB_IDS` 已含
        `files`（`lib/containers.ts:47`：树的面板 id 就是 `files`，D-1777/D-1778），
        而这里原先没有 `files` 分支 ⇒ dockview 路径把 `files` 面板渲染成**空壳**
        （真浏览器实测：`[data-dockview-panel="files"]` 的 innerHTML 长度 11、textContent 空），
        同时手写路径的 `#files` slot 却是真的树 —— 同一条面板契约两处不一致。
        内容与手写路径 `#files` slot **逐字同形**（wrapper testid / class / `@collapse` 接线），
        两条路径从此共用这一份。
    -->
    <div
        v-if="id === 'files'"
        data-testid="workspace-file-tree"
        class="flex h-full min-h-0 flex-1 flex-col"
    >
        <FileTreePanel @collapse="emit('collapseTree')" />
    </div>
    <FileEditor v-else-if="id === 'code'" />
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
    <!--
        task-138（D-1907 rev10）：容器内的「会话配置」页签。id 是第三形态
        `pane:<container>:session-config:<sid>`，**开哪份会话的配置由 id 里的 sid 说了算**（不是
        宿主当前会话），否则两栏各开一份就串台成同一份。非法/缺 sid 才回退宿主 sessionId。
    -->
    <SessionContextPanel
        v-else-if="paneTabView(id) === SESSION_CONFIG_VIEW"
        :session-id="paneTabSessionId(id) ?? sessionId ?? null"
    />
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
        :expand-principal-id="agentId ?? null"
    />
</template>
