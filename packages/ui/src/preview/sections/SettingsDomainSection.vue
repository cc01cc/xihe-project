<script setup lang="ts">
import SectionShell from "../SectionShell.vue";
import DomainScreen from "../settingsIa/DomainScreen.vue";
</script>

<template>
    <SectionShell
        id="settings-domain"
        index="11"
        title="域页样板（rag）：每项右侧层徽标 + 继承链跳转"
        description="每个配置项右侧是层徽标（工作区覆盖 / 用户 / 实例只读），被覆盖项下方一行「↳ 实例 64k / 用户 96k」是跳转链接：点它高亮同一条在目标层的取值。实例锁与 env 锁用两种不同徽标（PLAN-0556）。"
    >
        <DomainScreen />
    </SectionShell>
</template>
