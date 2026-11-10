<script setup lang="ts">
import FoldPanel from "./FoldPanel.vue";

/**
 * Sheet 03 — the two folding states, side by side.
 *
 * `Collapsible` is the vendored primitive behind group folding (Apple HIG "group hierarchy with
 * disclosure controls"). 折叠的粒度是**层**：左边折起「实例」、展开「用户」；右边反过来。
 *
 * 注意这不是「切换层」控件 —— 层由 URL 决定（`/settings/instance/**` vs `/settings/user/**`），
 * 折叠只影响看见多少；用户层展开后点条目才发生导航（2026-11-10 用户裁定的口径）。
 */
</script>

<template>
    <div class="flex h-full min-h-0">
        <section class="flex min-w-0 flex-1 flex-col border-r border-border">
            <div
                class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5"
            >
                <span class="mk-caption font-semibold">A</span>
                <span class="mk-caption text-muted-foreground"
                    >「实例」折起 · 「用户」展开（非当前层，只是看一眼）</span
                >
            </div>
            <div class="flex min-h-0 flex-1 gap-8 px-10 py-8">
                <FoldPanel :instance-open="false" :user-open="true" />
                <div class="min-w-0 flex-1 rounded-lg border border-dashed border-border p-6">
                    <p class="mk-caption leading-6 text-muted-foreground">
                        折起后组标题**仍带计数**（实例 17 / 用户
                        4），所以「这一组有几项」不依赖展开动作。
                    </p>
                    <p class="mt-3 mk-caption leading-6 text-muted-foreground">
                        当前选中项在「实例」组内：折起时这一行不可见，因此组标题需要能表达「组内有选中」——
                        这是 §A 与 §B 要对照的地方。
                    </p>
                    <p class="mt-3 mk-caption leading-6 text-muted-foreground">
                        左栏没有任何「切换层」控件：层写在地址里（<span class="font-mono"
                            >/settings/instance</span
                        >），展开另一层只多看见几行，点下去才换路由。
                    </p>
                </div>
            </div>
        </section>
        <section class="flex min-w-0 flex-1 flex-col">
            <div
                class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5"
            >
                <span class="mk-caption font-semibold">B</span>
                <span class="mk-caption text-muted-foreground">「实例」展开 · 「用户」折起</span>
            </div>
            <div class="flex min-h-0 flex-1 gap-8 px-10 py-8">
                <FoldPanel :instance-open="true" :user-open="false" />
                <div class="min-w-0 flex-1 rounded-lg border border-dashed border-border p-6">
                    <p class="mk-caption leading-6 text-muted-foreground">
                        展开态：16px lucide 图标 + 文字 + 右侧计数徽标；选中行是
                        <span class="font-mono">2px</span> 左侧指示条 + 浅底，不是整行填色。
                    </p>
                    <p class="mt-3 mk-caption leading-6 text-muted-foreground">
                        <span class="font-mono">CollapsibleTrigger</span>
                        自带切换行为，模板里不得再绑 click（reka-ui 陷阱，见
                        packages/ui/AGENTS.md）。
                    </p>
                    <p class="mt-3 mk-caption leading-6 text-muted-foreground">
                        实例组内仍按「域 12 / 实例运维 2 / 安全与权限
                        3」分段——层是第一维，分段是层内第二维。
                    </p>
                </div>
            </div>
        </section>
    </div>
</template>
