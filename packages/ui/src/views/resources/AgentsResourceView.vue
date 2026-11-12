<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import InstanceAgentsPanel from "../../components/settings/InstanceAgentsPanel.vue";
import AgentPrincipalsPanel from "../../components/settings/AgentPrincipalsPanel.vue";
import { resolveResourceLayer } from "../../lib/settingsIa";

/**
 * PLAN-0772 M2：智能体资源页（`/resources/agents?layer=USER|INSTANCE`）。
 *
 * <p>两层，语义**不同轴**（别互相顶替）：</p>
 * <ul>
 *   <li>`USER` = 你个人的**智能体主体**（`agent-principals`，`created_by=self` 的个人视图、
 *       无工作区上下文的创建走 `CREATE_OWN_AGENT`）—— 面板仍是 `AgentPrincipalsPanel`。</li>
 *   <li>`INSTANCE` = **平台智能体**（D-1006 B4：全平台可用、仅实例管理员可建）—— 面板仍是
 *       `InstanceAgentsPanel`。</li>
 * </ul>
 * <p>工作区层的智能体**不在这里**：那是「成员 / 绑定」面（`WorkspaceAgentsPanel` + 成员管理），
 * 属 PLAN-0772 目标 3（受 `decisions-pending` 第 40 条前置约束，未裁不启动）。</p>
 */
const route = useRoute();
const layer = computed(() => resolveResourceLayer("agents", route.query.layer));
</script>

<template>
    <InstanceAgentsPanel v-if="layer === 'INSTANCE'" />
    <AgentPrincipalsPanel v-else />
</template>
