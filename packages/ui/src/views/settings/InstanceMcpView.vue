<script setup lang="ts">
import InstanceMcpPanel from "../../components/settings/InstanceMcpPanel.vue";

/**
 * task-165 · 实例层「MCP 注册表」落地页（`/settings/instance/mcp`，`meta.settingsLayer = "instance"`）。
 *
 * <p>与 `SkillsView` 同构：这层只做壳，四态（加载/错误/空/无权限）与全部动作都在
 * `InstanceMcpPanel` 里 —— 单测直接挂面板，不为测一个列表再搭一条路由。</p>
 */
</script>

<template>
    <main class="mx-auto max-w-6xl px-4 py-6">
        <InstanceMcpPanel />
    </main>
</template>
