<script setup lang="ts">
/**
 * task-127 页底三条：rail / 聊天条 / 库 —— 用户裁定「全部放到一起、同一体系」。
 * 简化示意（非独立场景稿）：同一字阶四档 + 同一栅格；rail 按 D-899 无语言控件。
 */
const RAIL_ITEMS = [
    { icon: "⌂", label: "工作区" },
    { icon: "▤", label: "知识库" },
    { icon: "⚙", label: "设置" },
];
const LIB_ROWS = [
    { name: "产品手册 v2.md", chunks: 128, updated: "2026-11-08" },
    { name: "API 契约摘录.md", chunks: 46, updated: "2026-11-10" },
];
</script>

<template>
    <section class="mb-4">
        <h2 class="mk-subtitle mb-1">同体系参考区（rail / 聊天 / 库）</h2>
        <p class="mk-caption mb-6 text-muted-foreground">
            与设置区同页同体系；rail 已按 D-899 撤语言控件（入口 = 设置 · 用户层 · user-preference）
        </p>

        <div class="grid grid-cols-3 gap-4">
            <!-- rail 双态 -->
            <div class="rounded-lg border bg-card p-4" data-mock-strip="rail">
                <p class="mk-caption mb-3 text-muted-foreground">全局栏 · 双态</p>
                <div class="flex gap-3">
                    <div class="w-14 rounded-md border p-1.5">
                        <div
                            v-for="item in RAIL_ITEMS"
                            :key="'c' + item.label"
                            class="mk-caption mb-1 flex h-8 items-center justify-center rounded text-muted-foreground last:mb-0"
                            :title="item.label"
                        >
                            {{ item.icon }}
                        </div>
                    </div>
                    <div class="w-36 rounded-md border p-1.5">
                        <div
                            v-for="item in RAIL_ITEMS"
                            :key="'e' + item.label"
                            class="mk-body mb-1 flex h-8 items-center gap-2 rounded px-2 last:mb-0"
                        >
                            <span class="text-muted-foreground">{{ item.icon }}</span>
                            <span>{{ item.label }}</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 聊天条 -->
            <div class="rounded-lg border bg-card p-4" data-mock-strip="chat">
                <p class="mk-caption mb-3 text-muted-foreground">聊天输入条</p>
                <div class="rounded-md border bg-background px-3 py-2">
                    <p class="mk-body text-muted-foreground">问点什么…（@ 引用工作区文件）</p>
                    <div class="mt-2 flex items-center justify-between">
                        <span class="mk-caption text-muted-foreground">⎘ 引用 · ⌘ 工具</span>
                        <span
                            class="rounded bg-primary px-2.5 py-1 mk-caption font-medium text-primary-foreground"
                            >发送</span
                        >
                    </div>
                </div>
            </div>

            <!-- 库 -->
            <div class="rounded-lg border bg-card p-4" data-mock-strip="library">
                <p class="mk-caption mb-3 text-muted-foreground">知识库 · 文档行</p>
                <div
                    v-for="row in LIB_ROWS"
                    :key="row.name"
                    class="mk-body mb-2 flex items-center justify-between rounded-md border px-3 py-2 last:mb-0"
                >
                    <span class="font-mono text-[13px]">{{ row.name }}</span>
                    <span class="mk-caption text-muted-foreground"
                        >{{ row.chunks }} 块 · {{ row.updated }}</span
                    >
                </div>
            </div>
        </div>
    </section>
</template>
