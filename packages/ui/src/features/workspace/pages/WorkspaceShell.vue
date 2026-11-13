<script setup lang="ts">
import WorkspaceSecondaryNav from "../components/WorkspaceSecondaryNav.vue";

/**
 * 工作区路由外壳（PLAN-0773 `M4-4` / `task-190`）：把二级导航放在**所有工作区子页之上**，
 * 子页本身不动（它们仍由路由表声明，导航项也从路由表派生）。
 *
 * <p><b>高度链（PLAN-0626 不变量）</b>：`AppLayout` 已经把页签栏以下的高度交给路由页
 * （`data-testid="workspace-route-viewport"` 的 `min-h-0 flex-1 overflow-y-auto`）。
 * 所以这里 `h-full min-h-0 flex` 竖排，导航占它自己的高度，**剩余高度**用 `min-h-0 flex-1`
 * 交给 `RouterView` —— 只改这一个容器，工作台/聊天页的 `h-full` 仍然拿到正确高度。</p>
 */
</script>

<template>
    <div data-testid="workspace-shell" class="flex h-full min-h-0 flex-col">
        <WorkspaceSecondaryNav />
        <div class="min-h-0 flex-1 overflow-y-auto">
            <RouterView />
        </div>
    </div>
</template>
