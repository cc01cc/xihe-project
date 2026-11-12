<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import InstanceMcpPanel from "../../components/settings/InstanceMcpPanel.vue";
import WorkspaceMcpPanel from "../../features/workspace/components/WorkspaceMcpPanel.vue";
import ResourceWorkspaceRequired from "../../components/resources/ResourceWorkspaceRequired.vue";
import { resolveResourceLayer } from "../../lib/settingsIa";
import { readTabWorkspaceId } from "../../lib/workspaceContext";

/**
 * PLAN-0772 M2：MCP 资源页（`/resources/mcp?layer=WORKSPACE|INSTANCE`）。
 *
 * <p>只有两层：`mcp_remote_servers.workspace_id NOT NULL`（audit §F G1）⇒ 没有个人层，
 * 所以 `?layer=USER` 会被 `resolveResourceLayer` 落回默认层（`WORKSPACE`），而不是渲染一张空页。</p>
 */
const route = useRoute();
const layer = computed(() => resolveResourceLayer("mcp", route.query.layer));
const workspaceId = computed(() => readTabWorkspaceId());
</script>

<template>
    <InstanceMcpPanel v-if="layer === 'INSTANCE'" />
    <ResourceWorkspaceRequired v-else-if="!workspaceId" />
    <WorkspaceMcpPanel v-else :workspace-id="workspaceId" />
</template>
