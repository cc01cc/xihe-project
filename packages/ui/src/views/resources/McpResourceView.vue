<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import InstanceMcpPanel from "../../components/settings/InstanceMcpPanel.vue";
import WorkspaceLayerMovedNotice from "../../components/settings/WorkspaceLayerMovedNotice.vue";
import { resolveResourceLayer, type ResourceLayer } from "../../lib/settingsIa";
import { readTabWorkspaceId } from "../../lib/workspaceContext";

/**
 * PLAN-0772 M2：MCP 资源页（`/resources/mcp?layer=WORKSPACE|INSTANCE`）。
 *
 * <p>只有两层：`mcp_remote_servers.workspace_id NOT NULL`（audit §F G1）⇒ 没有个人层，
 * 所以 `?layer=USER` 会被 `resolveResourceLayer` 落回默认层（`WORKSPACE`），而不是渲染一张空页。</p>
 *
 * <p><b>D-1432 / task-41（用户 2026-11-15 裁定）</b>：MCP 的「本工作区」层**搬回工作区设置**
 * （`/workspace/:id/settings?tab=mcp`），本页的 WORKSPACE 层改为**指路**，不再渲染面板。
 * 这是 task-209（D-1019）的反向处理，语义沿用同一条 —— 不 404、不静默跳走：
 * 说明搬到哪了 + 一条能直接点过去的深链。实例层不受影响。</p>
 *
 * <p><b>搬家必核权限门</b>（task-209 记过一次真事故：`McpResourceView` 搬出 `/settings` 后漏了
 * `:readonly="!auth.canWriteWorkspace"`，VIEWER 看到可编辑的 JSON 框）：那一面现在由
 * 工作区设置页的 `mcp` 页签承接，门跟着搬过去（`WorkspaceSettingsView.vue`）—— 本页已无编辑面。</p>
 */
/**
 * task-210（PLAN-0773 M4-2）：两个可选 prop 让工作区页/资源页**钉死本工作区层**。
 * 搬回设置后工作区资源页不再挂本视图（那一页对已迁资源走指路），但 prop 契约保留：
 * 它也是「层不由 `?layer=` 决定」的唯一表达方式，删掉会让深链解析重新变成隐式顺序问题。
 */
const props = defineProps<{ layer?: ResourceLayer; workspaceId?: string }>();

const route = useRoute();
const layer = computed(() => props.layer ?? resolveResourceLayer("mcp", route.query.layer));
/** 先看显式 prop（工作区页），再回落本页签上下文（全局资源页的既有口径）。 */
const workspaceId = computed(() => props.workspaceId?.trim() || readTabWorkspaceId() || "");
</script>

<template>
    <InstanceMcpPanel v-if="layer === 'INSTANCE'" />
    <WorkspaceLayerMovedNotice v-else resource="mcp" :workspace-id="workspaceId" />
</template>
