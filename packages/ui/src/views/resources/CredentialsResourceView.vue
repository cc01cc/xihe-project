<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import CredentialsPanel from "../../components/settings/credentials/CredentialsPanel.vue";
import InstanceCredentialsPanel from "../../components/settings/InstanceCredentialsPanel.vue";
import ResourceWorkspaceRequired from "../../components/resources/ResourceWorkspaceRequired.vue";
import { resolveResourceLayer, type ResourceLayer } from "../../lib/settingsIa";
import { readTabWorkspaceId } from "../../lib/workspaceContext";

/**
 * PLAN-0772 M2：凭据资源页（`/resources/credentials?layer=USER|WORKSPACE|INSTANCE`）。
 *
 * <p>**只做宿主**：三层各自沿用原面板（凭据 = `CredentialsPanel` 的两个 ownerType 分支 +
 * `InstanceCredentialsPanel`），本文件不复制任何列表/表单逻辑 —— 与 `task-83`「视图只做壳」的同一条纪律。</p>
 *
 * <p>层从 `?layer=` 来（大小写都收，非法值回落默认层），**不读 `meta.settingsLayer`**：资源面的层
 * 不是设置区的层（`RESOURCE_DEFS` 是唯一口径，见 `settingsIa`）。</p>
 */
/**
 * task-210（PLAN-0773 M4-2）：**两个可选 prop** 让工作区资源页
 * （`/workspace/:id/resources`）**钉死本工作区层**。
 *
 * <p>不传时行为与全局资源页逐字节相同：层仍由 `?layer=` 解析、workspace 仍取本页签上下文
 * （`readTabWorkspaceId`）。工作区页传 `layer="WORKSPACE"` + 路由里的 workspaceId ⇒
 * 页面自己建立前提，不依赖「上一个页面写过 pt 上下文」这种隐性顺序。</p>
 */
const props = defineProps<{ layer?: ResourceLayer; workspaceId?: string }>();

const route = useRoute();
const layer = computed(() => props.layer ?? resolveResourceLayer("credentials", route.query.layer));
/** 先看显式 prop（工作区页），再回落本页签上下文（全局资源页的既有口径）。 */
const workspaceId = computed(() => props.workspaceId?.trim() || readTabWorkspaceId());
</script>

<template>
    <InstanceCredentialsPanel v-if="layer === 'INSTANCE'" />
    <ResourceWorkspaceRequired v-else-if="layer === 'WORKSPACE' && !workspaceId" />
    <CredentialsPanel v-else-if="layer === 'WORKSPACE'" owner-type="WORKSPACE" />
    <CredentialsPanel v-else owner-type="USER" />
</template>
