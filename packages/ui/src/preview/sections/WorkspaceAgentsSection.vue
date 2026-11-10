<script setup lang="ts">
import SectionShell from "../SectionShell.vue";
import WorkspaceAgentsScreen from "../settingsIa/WorkspaceAgentsScreen.vue";
</script>

<template>
    <SectionShell
        id="workspace-agents"
        index="12"
        title="工作区设置 · 智能体绑定（来源列 + 工作区角色 + 绑定/解绑）"
        description="面包屑「设置 › 工作区层 › 智能体绑定」。权限那列已定形为工作区角色两档：只读（WS_VIEWER）/ 读写（WS_EDITOR），并注明「读写 = read/write/delete/exec；不含网络访问与凭据使用（那两档在 WS_OWNER/ADMIN）」——依据 V87:131-134，不是新权限轴。列表带来源列（来自实例 / 来自我的凭据）与绑定/解绑；右侧空态给「去用户配置 → 智能体主体创建」的可操作指引。"
    >
        <WorkspaceAgentsScreen />
    </SectionShell>
</template>
