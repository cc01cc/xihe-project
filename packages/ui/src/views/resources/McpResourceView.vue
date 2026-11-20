<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import InstanceMcpPanel from "../../components/settings/InstanceMcpPanel.vue";
import { resolveResourceLayer, type ResourceLayer } from "../../lib/settingsIa";

/**
 * PLAN-0772 M2：MCP 资源页（`/resources/mcp?layer=WORKSPACE|INSTANCE`）。
 *
 * <p>只有两层：`mcp_remote_servers.workspace_id NOT NULL`（audit §F G1）⇒ 没有个人层，
 * 所以 `?layer=USER` 会被 `resolveResourceLayer` 落回默认层，而不是渲染一张空页。</p>
 *
 * <p><b>D-1432 / task-41 + task-145 / DSD-1511</b>：MCP 的「本工作区」层**搬回工作区设置**
 * （`/workspace/:id/settings?tab=mcp`）⇒ 本页只剩实例层：页签集合由
 * `visibleLayersForResource` 派生（已迁层不再出现），`?layer=WORKSPACE` 深链**静默回落**到
 * 默认层（INSTANCE）。原来的 WORKSPACE 指路卡（`WorkspaceLayerMovedNotice`）已按
 * 「MVP 前不留请到别处的空壳」整件删除。</p>
 *
 * <p><b>搬家必核权限门</b>（task-209 记过一次真事故：`McpResourceView` 搬出 `/settings` 后漏了
 * `:readonly="!auth.canWriteWorkspace"`，VIEWER 看到可编辑的 JSON 框）：那一面现在由
 * 工作区设置页的 `mcp` 页签承接，门跟着搬过去（`WorkspaceSettingsView.vue`）——
 * 本页已无编辑面，task-145 起连只读指路面也没有了。</p>
 */
/**
 * task-210（PLAN-0773 M4-2）/ task-145：`layer` prop 仍是「层不由 `?layer=` 决定」的表达方式
 * （工作区页需要钉死本工作区层时用它），删掉会让深链解析重新变成隐式顺序问题。
 * `workspaceId` prop 随指路卡一起删除 —— 本页已无任何需要工作区上下文的渲染分支。
 */
const props = defineProps<{ layer?: ResourceLayer }>();

const route = useRoute();
const layer = computed(() => props.layer ?? resolveResourceLayer("mcp", route.query.layer));
</script>

<template>
    <!-- task-145：只剩实例层（已迁的 WORKSPACE 层不再渲染任何东西，深链已静默回落）。 -->
    <InstanceMcpPanel v-if="layer === 'INSTANCE'" />
</template>
