<script setup lang="ts">
import { computed } from "vue";
import { useRoute } from "vue-router";
import CredentialsPanel from "../../components/settings/credentials/CredentialsPanel.vue";
import InstanceCredentialsPanel from "../../components/settings/InstanceCredentialsPanel.vue";
import ResourceWorkspaceRequired from "../../components/resources/ResourceWorkspaceRequired.vue";
import { resolveResourceLayer } from "../../lib/settingsIa";
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
const route = useRoute();
const layer = computed(() => resolveResourceLayer("credentials", route.query.layer));
const workspaceId = computed(() => readTabWorkspaceId());
</script>

<template>
    <InstanceCredentialsPanel v-if="layer === 'INSTANCE'" />
    <ResourceWorkspaceRequired v-else-if="layer === 'WORKSPACE' && !workspaceId" />
    <CredentialsPanel v-else-if="layer === 'WORKSPACE'" owner-type="WORKSPACE" />
    <CredentialsPanel v-else owner-type="USER" />
</template>
