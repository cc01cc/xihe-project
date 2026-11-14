<script setup lang="ts">
import SettingsGroupView from "./SettingsGroupView.vue";
import type { ConfigLayer } from "../../stores/config";
import { AGENT_CONFIG_GROUP_ID } from "../../lib/settingsIa";

/**
 * 智能体配置组页（薄壳）：真正的组页实现在 `SettingsGroupView.vue`（task-485 起两组共用）。
 * 保留本文件是为了不动既有路由组件路径与 `views/settings/__tests__/ModelConfigView.spec.ts` 的挂载点。
 */
defineProps<{ layer: ConfigLayer }>();
</script>

<template>
    <SettingsGroupView :layer="layer" :group-id="AGENT_CONFIG_GROUP_ID" />
</template>
