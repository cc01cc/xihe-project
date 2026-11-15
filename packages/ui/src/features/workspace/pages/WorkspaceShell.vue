<script setup lang="ts">
import WorkspaceSecondaryNav from "../components/WorkspaceSecondaryNav.vue";
import WorkspaceStatusBar from "../components/WorkspaceStatusBar.vue";

/**
 * 工作区路由外壳（PLAN-0773 `M4-4` / `task-190`）：把一行导航放在**所有工作区子页之上**，
 * 底部状态栏放在**所有子页之下**（task-160 / S2a）。子页本身不动（它们仍由路由表声明，
 * 导航项也从路由表派生）。
 *
 * <p><b>高度链（PLAN-0626 不变量）</b>：`AppLayout` 已经把页签栏以下的高度交给路由页
 * （`data-testid="workspace-route-viewport"` 的 `min-h-0 flex-1 overflow-y-auto`）。
 * 所以这里 `h-full min-h-0 flex` 竖排：导航占自己的高度 → 路由页用 `min-h-0 flex-1` 吃掉
 * 剩余高度 → 状态栏 `shrink-0` 在最后。**两条 chrome 都逐层扣除**，路由页拿到的仍是
 * 「导航与状态栏之间」的净高度（`h-full` 的工作台/聊天页因此仍然正确）。</p>
 *
 * <p><b>状态栏为什么在壳层（task-160 / `D-1527`）</b>：面包屑从导航行搬进状态栏后，
 * 它必须在**每个**工作区页都可见；页面级挂载只有聊天页有状态栏，其余五页会没有面包屑。
 * 读数来源见 `WorkspaceStatusBar.vue` 头部（连接态 / 用量由页面发布到 store，待审批读全局 store）。</p>
 */
</script>

<template>
    <div data-testid="workspace-shell" class="flex h-full min-h-0 flex-col">
        <WorkspaceSecondaryNav />
        <div class="min-h-0 flex-1 overflow-y-auto">
            <RouterView />
        </div>
        <!--
            task-160：状态栏是**壳级的第三条 chrome**，不是路由页的一部分（面包屑要在六页都可见）。
            `shrink-0` 与移动端隐藏由组件自己负责（`max-md:hidden`：移动端走 sheets，没有这层空间）。
        -->
        <WorkspaceStatusBar />
    </div>
</template>
