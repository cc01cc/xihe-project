<script setup lang="ts">
/**
 * 资源页（`WorkspaceResourcesView`）异步面板的**加载占位**（task-10 / batch-2 第 1 条）。
 *
 * <p><b>为什么需要它</b>：四个面板都是 `defineAsyncComponent`（按需分包），首帧要等 chunk
 * 下载 + 组件初始化。实测（batch-2 自审）：这段等待期主体**完全空白** —— 既没有骨架也没有提示，
 * 用户看到的是「点了页签，页面白了」，与「加载失败」和「这一层没有内容」都分不出来。
 * 三态覆盖（加载/空/错误）里只有空态与错误态有文案，加载态靠 JS 默认 `null`。</p>
 *
 * <p><b>为什么是骨架 + 文案而不是只转圈</b>：只给转圈仍然说不出「下面会出现什么」；
 * 骨架用两行条状块示意「面板标题 + 表格」，是同一屏里的布局提示。骨架带 `aria-hidden`
 * —— 读屏用户不需要它，只要 `role="status"` 那一句。</p>
 */
import { LoaderCircle } from "@lucide/vue";
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
    <div data-testid="resource-pane-loading" role="status" aria-live="polite" class="p-4">
        <p class="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle class="size-4 animate-spin" aria-hidden="true" />
            {{ t("common.loading") }}
        </p>
        <div class="mt-3 space-y-2" aria-hidden="true">
            <div class="h-8 w-1/3 rounded bg-muted/60"></div>
            <div class="h-4 w-2/3 rounded bg-muted/40"></div>
            <div class="h-4 w-1/2 rounded bg-muted/40"></div>
        </div>
    </div>
</template>
