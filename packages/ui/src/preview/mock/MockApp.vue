<!--
  DEPRECATED(task-137-rev2)：D-914 ① 交付改为「真产品页面 + 网络层 mock」，本文件属更早的「静态设计稿单页」路线，已不再渲染也不再产出交付图；**保留不删**（Lead 口径：零删除，退役由 PLAN-0764 M1 合并时统一处理）。指标：task-137 rev2 的真实入口是 preview-real.html + src/preview/mock/api-server.ts。
-->
<script setup lang="ts">
import MockWindow from "./screens/MockWindow.vue";
import MockSinglePage from "./screens/MockSinglePage.vue";

/**
 * task-127（D-903）：**单页合一** —— 用户裁定「mock 稿一个页面就够了，顶上那么多按钮切场景是什么」。
 * SHEETS/hash 切换器已撤（git 历史可查 task-126 前的实现）；旧场景屏 S1..S6 保留在
 * screens/ 目录但不再被入口引用。入口 = 本组件 → MockWindow（真窗口构图）→ MockSinglePage 单页。
 *
 * task-137（B）：整窗构图 —— rail 56 + 设置左栏 256 + 内容列 + 聊天条 + 右 dock 360。
 * `?winlong=1` ⇒ 窗口高度随内容撑开（单页长图取景）；默认 = 窗口固定 1920×1080（整窗视口图取景）。
 */
const params = new URLSearchParams(window.location.search);
const winlong = params.get("winlong") === "1";
</script>

<template>
    <div data-mock-canvas class="min-h-screen bg-muted/20 p-6 text-foreground">
        <MockWindow :tall="winlong">
            <MockSinglePage />
        </MockWindow>
        <!-- 稿外注（不进窗口画面）：来源与判据。窗口截图取元素，天然不含这行。 -->
        <p class="mk-caption mx-auto mt-3 w-[1920px] text-muted-foreground">
            Xihe 设置区 · 单页设计稿（task-137 / task-127 / D-903）· 字段中文 label 复用产品 i18n
            键、无键走 curated 词典（74 字段 100% 覆盖）· 值/类型来源 = CP config-schemas（生成物
            schema-catalog.ts）· 用户层按 D-911 折叠展开 · 字阶四档（24/16/14/12）· 整窗 = rail 56 +
            设置左栏 256 + 内容列 + 聊天条 + 右 dock 360
        </p>
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
 *
 * 原先次位的自托管中文字族已移除（D-1132 / D-1133，task-266）：该族此前靠 `main.css` 的字体面声明
 * 提供，那条声明随字体自托管缓做一并删除 ⇒ 留着这个名字已从「确定命中自托管子集」退化成
 * 「装了这字体就命中、没装就落下一族」的环境相关行为。族名与关键字都不在此处重述 ——
 * 判据要求产品包对它们的机械命中为 0（`git grep -c`），注释里的字面量同样会命中。
 */
[data-mock-canvas] {
    font-family: "Geist Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
</style>
