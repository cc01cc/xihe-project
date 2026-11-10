<script setup lang="ts">
import MyAgentsPanel from "../../components/settings/MyAgentsPanel.vue";

/**
 * PLAN-0750 M3（矩阵 U3）：用户层「我的智能体」落地页。
 *
 * <p>路由 `/settings/my-agents`，`meta.settingsLayer = "user"`（左栏走「我的资源」分组）。
 * 页面本身只做壳：授权分流、列表、创建与绑定动作都在 `MyAgentsPanel` 里，
 * 这样单测可以直接挂面板，不必再搭一层路由。</p>
 */
</script>

<template>
    <main class="mx-auto max-w-5xl px-4 py-6">
        <MyAgentsPanel />
    </main>
</template>
