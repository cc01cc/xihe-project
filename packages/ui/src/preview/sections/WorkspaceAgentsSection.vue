<script setup lang="ts">
import SectionShell from "../SectionShell.vue";
import WorkspaceAgentsScreen from "../settingsIa/WorkspaceAgentsScreen.vue";
</script>

<template>
    <SectionShell
        id="workspace-agents"
        index="12"
        title="工作区设置 · 智能体绑定（来源列 + 绑定/解绑 + 空态）"
        description="列表带来源列（来自实例 / 来自我的凭据）、权限上限与绑定/解绑；右侧空态给「去用户配置 → 我的智能体创建」的可操作指引，避免用户以为要管理员。"
    >
        <WorkspaceAgentsScreen />
    </SectionShell>
</template>
