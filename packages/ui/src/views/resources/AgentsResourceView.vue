<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import InstanceAgentsPanel from "../../components/settings/InstanceAgentsPanel.vue";
import AgentPrincipalsPanel from "../../components/settings/AgentPrincipalsPanel.vue";
import ResourceWorkspaceRequired from "../../components/resources/ResourceWorkspaceRequired.vue";
import WorkspaceAgentsPanel from "../../features/workspace/components/WorkspaceAgentsPanel.vue";
import { resolveResourceLayer, type ResourceLayer } from "../../lib/settingsIa";
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
/**
 * task-210（PLAN-0773 M4-2）：**两个可选 prop** 让工作区资源页
 * （`/workspace/:id/resources`）**钉死本工作区层**。
 *
 * <p>不传时行为与全局资源页逐字节相同：层仍由 `?layer=` 解析、workspace 仍取本页签上下文
 * （`readTabWorkspaceId`）。工作区页传 `layer="WORKSPACE"` + 路由里的 workspaceId ⇒
 * 页面自己建立前提，不依赖「上一个页面写过页签上下文」这种隐性顺序。</p>
 */
const props = defineProps<{ layer?: ResourceLayer; workspaceId?: string }>();

const route = useRoute();
const layer = computed(() => props.layer ?? resolveResourceLayer("agents", route.query.layer));
/** 先看显式 prop（工作区页），再回落本页签上下文（全局资源页的既有口径）。 */
const workspaceId = computed(() => props.workspaceId?.trim() || readTabWorkspaceId());
</script>

<template>
    <InstanceAgentsPanel v-if="layer === 'INSTANCE'" />
    <ResourceWorkspaceRequired v-else-if="layer === 'WORKSPACE' && !workspaceId" />
    <WorkspaceAgentsPanel v-else-if="layer === 'WORKSPACE'" :workspace-id="workspaceId ?? ''" />
    <AgentPrincipalsPanel v-else />
</template>
