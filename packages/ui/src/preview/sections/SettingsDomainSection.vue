<script setup lang="ts">
import SectionShell from "../SectionShell.vue";
import DomainScreen from "../settingsIa/DomainScreen.vue";
</script>

<template>
    <SectionShell
        id="settings-domain"
        index="11"
        title="域页样板（rag）：面包屑三段 + 层标题 24px > 域标题 18px > 条目行 ≥44px"
        description="面包屑「设置 › 实例层 › 检索增强（RAG）」，末段 aria-current=page；域标题 18px 严格小于层标题 24px，条目行高 ≥44px。每个配置项右侧是层徽标（工作区覆盖 / 用户 / 实例只读），被覆盖项下方「↳ 实例 64k / 用户 96k」是跳转链接：点它高亮同一条在目标层的取值。实例锁与 env 锁用两种不同徽标（PLAN-0556）。"
    >
        <DomainScreen />
    </SectionShell>
</template>
