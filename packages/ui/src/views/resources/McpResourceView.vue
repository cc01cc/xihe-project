<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import InstanceMcpPanel from "../../components/settings/InstanceMcpPanel.vue";
import WorkspaceMcpPanel from "../../features/workspace/components/WorkspaceMcpPanel.vue";
import ResourceWorkspaceRequired from "../../components/resources/ResourceWorkspaceRequired.vue";
import { resolveResourceLayer, type ResourceLayer } from "../../lib/settingsIa";
import { readTabWorkspaceId } from "../../lib/workspaceContext";
import { useAuthStore } from "../../stores/auth";

/**
 * PLAN-0772 M2：MCP 资源页（`/resources/mcp?layer=WORKSPACE|INSTANCE`）。
 *
 * <p>只有两层：`mcp_remote_servers.workspace_id NOT NULL`（audit §F G1）⇒ 没有个人层，
 * 所以 `?layer=USER` 会被 `resolveResourceLayer` 落回默认层（`WORKSPACE`），而不是渲染一张空页。</p>
 *
 * <p><b>task-209（D-1019）</b>：本页接管「工作区设置 → MCP」tab 之后，**必须同时接管它的只读门**
 * （`!auth.canWriteWorkspace`）。撤 tab 前那个入口传的是 `:readonly="!auth.canWriteWorkspace"`
 * （VIEWER 看到禁用 textarea、无保存按钮，见旧 `e2e/mock/plan-0560-settings.spec.ts`），
 * 若这里不传，VIEWER 在资源页会看到一个**可编辑**的 JSON 配置框 —— 属于「搬家顺手丢权限门」。</p>
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
const auth = useAuthStore();
const layer = computed(() => props.layer ?? resolveResourceLayer("mcp", route.query.layer));
/** 先看显式 prop（工作区页），再回落本页签上下文（全局资源页的既有口径）。 */
const workspaceId = computed(() => props.workspaceId?.trim() || readTabWorkspaceId());
</script>

<template>
    <InstanceMcpPanel v-if="layer === 'INSTANCE'" />
    <ResourceWorkspaceRequired v-else-if="!workspaceId" />
    <WorkspaceMcpPanel v-else :workspace-id="workspaceId" :readonly="!auth.canWriteWorkspace" />
</template>
