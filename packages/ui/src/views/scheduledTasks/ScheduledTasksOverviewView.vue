<script setup lang="ts">
import { Info } from "@lucide/vue";

/**
 * task-11（DSD-1518 B / D-1220 ③ 回退）：自动化任务的**实例级总览页**。
 *
 * <p>**这个页面此刻不渲染任何数据，也不许装成渲染了**。它存在的理由只有一个：把「自动化任务」
 * 从 rail 的**工作区面板项**（随工作区上下文出现/消失，同一功能两种可见性）改成**实例级模块入口**
 * —— 入口恒在，作用域由数据面决定。入口先立，数据面后接。</p>
 *
 * <p><b>数据面缺口的显式呈现</b>（Lead 本轮硬要求）：缺数据就写缺数据，文案必须点名
 * `GET /api/v1/scheduled-tasks` 与来源卡号 `task-10`，将来端点真接了，下一个人顺着 task-10
 * 能找到当初的实现，而不是在 `git log` 里瞎找。**禁止**用「加载中」「暂无数据」或一张空白列表
 * 伪装成品 —— 那会让人以为「列表本来就是空的」，属于把缺口藏起来（与 uifit-1 授权总览页同口径：
 * 缺面必须显式呈现、禁推断数据）。</p>
 *
 * <p><b>testid 只表达一种语义</b>：`scheduled-tasks-not-wired` = 「数据面未接入」，
 * 不是「空列表」，也不是「无权限」。将来接上端点时要**换**testid，而不是在原地改语义
 * （e2e 的 `getByTestId` 会命中相反含义，见 `InstanceReadonlyNotice.vue` 同款注释）。</p>
 *
 * <p><b>TODO（等 task-10 端点并入真栈构建后）</b>：本页文案目前**内联中文**，因为
 * `src/i18n/index.ts` 此刻被他人 WIP 占着（lead 硬约束：我零改动）。数据面接线那一笔同批
 * 把这三段文案换成 `t()` 键。</p>
 *
 * <p><b>为什么本页自己当滚动容器</b>：顶层路由页直挂 `ModuleStage`（`overflow-hidden` 的裁剪盒），
 * 页面根不声明滚动就永远滚不动 —— 判据与 `OrgMembersView.vue` 同源，
 * 结构门 `internal/A03-xihe/scripts/check-ui-route-scroll.mjs` 钉的就是这条。</p>
 */
</script>

<template>
    <main
        id="main-content"
        tabindex="-1"
        class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-card"
        data-testid="scheduled-tasks-page"
    >
        <header class="border-b">
            <div class="mx-auto w-full max-w-6xl px-6 pt-4 pb-3">
                <h1 class="text-2xl leading-tight font-semibold tracking-tight">自动化任务总览</h1>
                <p class="mt-1 max-w-3xl text-sm text-muted-foreground">
                    实例内跨工作区的自动化任务清单。
                </p>
            </div>
        </header>
        <div class="mx-auto w-full max-w-6xl px-6 py-4">
            <div
                data-testid="scheduled-tasks-not-wired"
                class="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs"
            >
                <Info class="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <div class="min-w-0 flex-1">
                    <p class="font-medium">数据面未接入：本页暂无任务清单，也不能开始操作</p>
                    <p class="mt-0.5 leading-relaxed text-muted-foreground">
                        清单数据来自控制面的 GET /api/v1/scheduled-tasks（来源
                        task-10）。该端点尚未并入当前构建， 所以这里既不显示任务、也不显示条数 ——
                        缺口如实呈现，不用空列表冒充「本来就没有任务」。
                    </p>
                </div>
            </div>
        </div>
    </main>
</template>
