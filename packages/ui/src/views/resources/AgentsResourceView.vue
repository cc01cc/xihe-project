<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import InstanceAgentsPanel from "../../components/settings/InstanceAgentsPanel.vue";
import AgentPrincipalsPanel from "../../components/settings/AgentPrincipalsPanel.vue";
import ResourceWorkspaceRequired from "../../components/resources/ResourceWorkspaceRequired.vue";
import WorkspaceAgentsPanel from "../../features/workspace/components/WorkspaceAgentsPanel.vue";
import { resolveResourceLayer } from "../../lib/settingsIa";
import { readTabWorkspaceId } from "../../lib/workspaceContext";

/**
 * PLAN-0772 M2 + task-203：智能体资源页（`/resources/agents?layer=USER|WORKSPACE|INSTANCE`）。
 *
 * <p>三层，语义**不同轴**（别互相顶替）：</p>
 * <ul>
 *   <li>`USER` = 你个人的**智能体主体**（`agent-principals`，`created_by=self` 的个人视图、
 *       无工作区上下文的创建走 `CREATE_OWN_AGENT`）—— 面板仍是 `AgentPrincipalsPanel`。</li>
 *   <li>`WORKSPACE` = **成员 / 绑定面**（复用既有 `WorkspaceAgentsPanel`，不新写面板）：
 *       回答用户 2026-11-12 的「成员入口的 agent principal 也别漏了」。读面
 *       `WorkspaceAgentController` 全 `isAuthenticated()`；写面绑定由 CP 守
 *       `MANAGE_WORKSPACE_AGENTS`（**工作区档**原子，见 `PermissionAtomCatalog.java:125`），
 *       ⇒ 层 tab 只判「有没有工作区上下文」，没有上下文时给诚实态，**不许静默空列表**。</li>
 *   <li>`INSTANCE` = **平台智能体**（D-1006 B4：全平台可用、仅实例管理员可建）—— 面板仍是
 *       `InstanceAgentsPanel`。</li>
 * </ul>
 */
const route = useRoute();
const layer = computed(() => resolveResourceLayer("agents", route.query.layer));
const workspaceId = computed(() => readTabWorkspaceId());
</script>

<template>
    <InstanceAgentsPanel v-if="layer === 'INSTANCE'" />
    <ResourceWorkspaceRequired v-else-if="layer === 'WORKSPACE' && !workspaceId" />
    <WorkspaceAgentsPanel v-else-if="layer === 'WORKSPACE'" :workspace-id="workspaceId ?? ''" />
    <AgentPrincipalsPanel v-else />
</template>
