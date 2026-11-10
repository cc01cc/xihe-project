<script setup lang="ts">
import { MessageSquarePlus, Search } from "@lucide/vue";
import SashHandle from "../SashHandle.vue";

/**
 * Sheet 05 — workspace three columns with the sash handles visible.
 *
 * Widths come from `useWorkspaceLayout`'s own ranges (nav 220-360 / tree 200-320 / dock 320-480,
 * main column floor 640). The middle sash is rendered in its **active** state so the ⋮ grip and the
 * live width bubble are both in frame; the outer sash shows the idle vs hover difference.
 */
const navWidth = 280;
const dockWidth = 360;
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex h-9 shrink-0 items-center border-b border-border bg-muted/40 px-4 text-xs">
            <span class="font-medium">xihe</span>
            <span class="mx-2 text-muted-foreground">/</span>
            <span class="text-muted-foreground">主工作区</span>
            <span class="ml-auto font-mono text-[11px] text-muted-foreground"
                >导航 {{ navWidth }} · 文件树 240 · 主列 flex · dock {{ dockWidth }}</span
            >
        </div>

        <div class="flex min-h-0 flex-1">
            <!-- 导航列 -->
            <div class="flex w-[280px] shrink-0 flex-col border-r-0 bg-muted/20">
                <div class="flex items-center gap-2 border-b border-border px-3 py-2">
                    <Search class="size-3.5 text-muted-foreground" />
                    <span class="text-xs text-muted-foreground">搜索会话</span>
                </div>
                <div class="space-y-1 p-2">
                    <div
                        v-for="i in 9"
                        :key="i"
                        class="h-7 rounded"
                        :class="i === 2 ? 'bg-accent' : 'bg-background/60'"
                    />
                </div>
                <div class="mt-auto flex items-center gap-2 border-t border-border px-3 py-2">
                    <MessageSquarePlus class="size-3.5" />
                    <span class="text-xs">新建会话</span>
                </div>
            </div>

            <SashHandle :value="navWidth" :min="220" :max="360" state="idle" />

            <!-- 文件树列 -->
            <div class="flex w-[240px] shrink-0 flex-col bg-muted/20">
                <div class="border-b border-border px-3 py-2 text-xs font-medium">文件</div>
                <div class="space-y-1 p-2">
                    <div v-for="i in 12" :key="i" class="h-6 rounded bg-background/60" />
                </div>
            </div>

            <SashHandle :value="240" :min="200" :max="320" state="active" />

            <!-- 主列 -->
            <div class="flex min-w-0 flex-1 flex-col bg-background">
                <div class="flex items-center gap-2 border-b border-border px-4 py-2">
                    <span class="text-xs font-medium">会话 · 主列（硬底线 640px）</span>
                    <span class="ml-auto font-mono text-[10px] text-muted-foreground">flex-1</span>
                </div>
                <div class="min-h-0 flex-1 space-y-3 p-5">
                    <div class="h-16 rounded-lg border border-border bg-muted/20" />
                    <div class="ml-10 h-10 rounded-lg border border-border bg-muted/10" />
                    <div class="h-16 rounded-lg border border-border bg-muted/20" />
                    <div class="ml-10 h-10 rounded-lg border border-border bg-muted/10" />
                </div>
                <div class="border-t border-border p-3">
                    <div class="h-10 rounded-lg border border-border bg-muted/20" />
                </div>
            </div>

            <SashHandle :value="dockWidth" :min="320" :max="480" state="hover" />

            <!-- 上下文列 -->
            <div class="flex w-[360px] shrink-0 flex-col bg-muted/20">
                <div class="flex border-b border-border text-xs">
                    <span class="border-b-2 border-foreground px-3 py-2 font-medium">文件</span>
                    <span class="px-3 py-2 text-muted-foreground">工具</span>
                    <span class="px-3 py-2 text-muted-foreground">智能体</span>
                </div>
                <div class="space-y-2 p-3">
                    <div v-for="i in 10" :key="i" class="h-6 rounded bg-background/60" />
                </div>
            </div>
        </div>

        <div class="flex h-12 shrink-0 items-center gap-6 border-t border-border px-4 text-[11px]">
            <span class="font-medium">抓手三态</span>
            <span class="flex items-center gap-2 text-muted-foreground"
                ><span class="inline-block h-4 w-2 rounded bg-border" /> idle：仅 1px
                分隔线，无抓手</span
            >
            <span class="flex items-center gap-2 text-muted-foreground"
                ><span class="inline-block h-4 w-2 rounded bg-foreground/40" /> hover：线加粗到 40%
                + 出现 ⋮ 圆钮</span
            >
            <span class="flex items-center gap-2 text-muted-foreground"
                ><span class="inline-block h-4 w-2 rounded bg-foreground/40" />
                active：拖拽中显示实时宽度浮标</span
            >
        </div>
    </div>
</template>
