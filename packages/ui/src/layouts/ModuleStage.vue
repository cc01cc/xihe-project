<script setup lang="ts">
/**
 * PLAN-0762 T2.2 —— 模块舞台（ModuleStage，DEV-010 §10.1）。
 *
 * <p>全局条右侧容器，一次只装一个模块：工作台（AppLayout）或设置页（SettingsLayout）。
 * 它只负责让模块拿到剩余高度；模块内部布局（导航面板 / 设置侧栏 / 内容列）仍由各模块
 * 自己的 layout 拥有。</p>
 */
</script>

<template>
    <div
        data-testid="module-stage"
        class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
        <slot />
    </div>
</template>
