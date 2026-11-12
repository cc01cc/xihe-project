<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import InstanceMcpPanel from "../../components/settings/InstanceMcpPanel.vue";
import WorkspaceMcpPanel from "../../features/workspace/components/WorkspaceMcpPanel.vue";
import ResourceWorkspaceRequired from "../../components/resources/ResourceWorkspaceRequired.vue";
import { resolveResourceLayer } from "../../lib/settingsIa";
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
const route = useRoute();
const auth = useAuthStore();
const layer = computed(() => resolveResourceLayer("mcp", route.query.layer));
const workspaceId = computed(() => readTabWorkspaceId());
</script>

<template>
    <InstanceMcpPanel v-if="layer === 'INSTANCE'" />
    <ResourceWorkspaceRequired v-else-if="!workspaceId" />
    <WorkspaceMcpPanel v-else :workspace-id="workspaceId" :readonly="!auth.canWriteWorkspace" />
</template>
