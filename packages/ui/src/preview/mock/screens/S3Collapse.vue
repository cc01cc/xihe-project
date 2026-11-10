<script setup lang="ts">
import FoldPanel from "./FoldPanel.vue";

/**
 * Sheet 03 — the two folding states, side by side.
 *
 * `Collapsible` is the vendored primitive behind group folding (Apple HIG "group hierarchy with
 * disclosure controls"). Left folds 「域」 and leaves 「我的资源」 open; right does the opposite, so
 * the reader compares the same rail in both states without clicking.
 */
</script>

<template>
    <div class="flex h-full min-h-0">
        <section class="flex min-w-0 flex-1 flex-col border-r border-border">
            <div
                class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5"
            >
                <span class="text-xs font-semibold">A</span>
                <span class="text-[11px] text-muted-foreground">「域」折起 · 「我的资源」展开</span>
            </div>
            <div class="flex min-h-0 flex-1 gap-8 px-10 py-8">
                <FoldPanel :domains-open="false" :resources-open="true" />
                <div class="min-w-0 flex-1 rounded-lg border border-dashed border-border p-6">
                    <p class="text-xs leading-6 text-muted-foreground">
                        折起后组标题**仍带计数**（域 12），所以「这一组有几项」不依赖展开动作。
                    </p>
                    <p class="mt-3 text-xs leading-6 text-muted-foreground">
                        当前选中项在「域」组内：折起时这一行不可见，因此组标题需要能表达「组内有选中」——
                        这是 §A 与 §B 要对照的地方。
                    </p>
                </div>
            </div>
        </section>
        <section class="flex min-w-0 flex-1 flex-col">
            <div
                class="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-5"
            >
                <span class="text-xs font-semibold">B</span>
                <span class="text-[11px] text-muted-foreground">「域」展开 · 「我的资源」折起</span>
            </div>
            <div class="flex min-h-0 flex-1 gap-8 px-10 py-8">
                <FoldPanel :domains-open="true" :resources-open="false" />
                <div class="min-w-0 flex-1 rounded-lg border border-dashed border-border p-6">
                    <p class="text-xs leading-6 text-muted-foreground">
                        展开态：16px lucide 图标 + 文字 + 右侧计数徽标；选中行是
                        <span class="font-mono">2px</span> 左侧指示条 + 浅底，不是整行填色。
                    </p>
                    <p class="mt-3 text-xs leading-6 text-muted-foreground">
                        <span class="font-mono">CollapsibleTrigger</span>
                        自带切换行为，模板里不得再绑 click（reka-ui 陷阱，见
                        packages/ui/AGENTS.md）。
                    </p>
                </div>
            </div>
        </section>
    </div>
</template>
