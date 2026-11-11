<script setup lang="ts">
import MockSinglePage from "./screens/MockSinglePage.vue";

/**
 * task-127（D-903）：**单页合一** —— 用户裁定「mock 稿一个页面就够了，顶上那么多按钮切场景是什么」。
 * SHEETS/hash 切换器已撤（git 历史可查 task-126 前的实现）；旧场景屏 S1..S6 保留在
 * screens/ 目录但不再被入口引用。入口 = 本组件 → MockSinglePage 单页。
 */
</script>

<template>
    <div data-mock-canvas class="min-h-screen bg-background text-foreground">
        <MockSinglePage />
    </div>
</template>

<style>
/**
 * 设置页 mock 的**字阶表**：只有 4 档，全站唯一来源。
 * title 24 / subtitle 16 / body 14 / caption 12 —— 档数 ≤ 4 是本卡验收判据之一，
 * 也是禁止逐稿手调像素字号字面量的原因（那些值彼此差 1px，只会在中英混排下放大不协调）。
 */
.mk-title {
    font-size: 24px;
    line-height: 32px;
    font-weight: 600;
    letter-spacing: -0.01em;
}
.mk-subtitle {
    font-size: 16px;
    line-height: 24px;
    font-weight: 600;
}
.mk-body {
    font-size: 14px;
    line-height: 22px;
}
.mk-caption {
    font-size: 12px;
    line-height: 18px;
}

/**
 * 文字族：`--font-sans` 首位是 Geist Variable，**Geist 没有中文字形** ⇒ 中文整段 fallback 到系统
 * sans-serif（Windows = 微软雅黑），中英文的字重与 x-height 完全不同，混排看起来「不协调」。
 * 这里显式声明中文回退，让中英文落在相近的中性无衬线族上。
 */
[data-mock-canvas] {
    font-family:
        "Geist Variable", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
</style>
