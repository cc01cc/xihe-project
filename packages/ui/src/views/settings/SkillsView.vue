<script setup lang="ts">
import SkillsPanel from "../../components/settings/SkillsPanel.vue";

/**
 * task-83 · 实例层「技能」落地页（`/settings/skills`，`meta.settingsLayer = "instance"`）。
 *
 * <p>只做壳：列表、展开取正文、空/加载/错误四态都在 `SkillsPanel` 里，
 * 单测直接挂面板（与 `AgentPrincipalsView` 同构，不为测一个列表再搭一层路由）。</p>
 *
 * <p>**为什么它不是后端缺口**：`GET /api/v1/skills` 的 `definitionScope` 默认就是 `instance`，
 * openapi 原文「Instance-scope definitions are visible to every authenticated caller」；
 * `/skills/{skillId}`、`/skills/{skillId}/bindings`、`/skills/import` 均已实现（PLAN-0628/0680）。
 * 所以左栏给真入口而不是灰显留位。</p>
 */
</script>

<template>
    <main class="mx-auto max-w-5xl px-4 py-6">
        <SkillsPanel />
    </main>
</template>
