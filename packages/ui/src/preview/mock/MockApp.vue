<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import S1SettingsAfter from "./screens/S1SettingsAfter.vue";
import S2BeforeAfter from "./screens/S2BeforeAfter.vue";
import S3Collapse from "./screens/S3Collapse.vue";
import S4GlobalNav from "./screens/S4GlobalNav.vue";
import S5WorkspaceSash from "./screens/S5WorkspaceSash.vue";
import S6EmptyAlert from "./screens/S6EmptyAlert.vue";
import SheetFrame from "./SheetFrame.vue";

/**
 * Sheet switcher for `preview-mock.html`.
 *
 * Screens are switched by **hash** (`#1`..`#6`) so the user can bookmark or reload any one of them,
 * and so one page load serves all six: nothing re-mounts a backend, nothing refetches.
 *
 * One sheet per viewport by design — each is a whole 1920x1080 frame, so whatever the user sees is
 * exactly what would be photographed. No scrolling, nothing cropped.
 */
const SHEETS = [
    {
        n: 1,
        label: "设置页·实例层（改造后）",
        question: "设置页的结构能不能一眼看懂：一条左栏 + 层分组 + 内容列 1152",
        note: "单左栏（无全局 rail）+ 实例/用户两层折叠分组 + 2px 选中条 + 内容列 1152px",
        comp: S1SettingsAfter,
    },
    {
        n: 2,
        label: "改造前 / 改造后",
        question: "同一屏的旧新对照，值不值得改",
        note: "左＝现网真实组件（SettingsSidebar + 手拼面包屑）；右＝改造后",
        comp: S2BeforeAfter,
    },
    {
        n: 3,
        label: "左栏分组折叠",
        question: "两层分组折起/展开后还能不能找到东西",
        note: "Collapsible 折起「实例」、展开「用户」——两态并排",
        comp: S3Collapse,
    },
    {
        n: 4,
        label: "全局导航条双态",
        question: "全局栏要不要、以及 56px 与 256px 两态各适合什么",
        note: "同一 Sidebar：56px 纯图标 ↔ 256px 图标+文字+模块名",
        comp: S4GlobalNav,
    },
    {
        n: 5,
        label: "工作区三栏 + sash",
        question: "三栏边界能不能看出可拖，宽度语义清不清楚",
        note: "列边界 hover 显示竖向三点 ⋮ + 高亮线",
        comp: S5WorkspaceSash,
    },
    {
        n: 6,
        label: "空态 + 权限不足",
        question: "没配置和没权限是两件事，用户能不能分清",
        note: "Empty（本域 0 项配置）与 Alert（缺少原子，不是后端缺口）",
        comp: S6EmptyAlert,
    },
] as const;

function readSheet(): number {
    const n = Number.parseInt(window.location.hash.replace("#", ""), 10);
    return SHEETS.some((s) => s.n === n) ? n : 1;
}

const active = ref(readSheet());
const current = computed(() => SHEETS.find((s) => s.n === active.value) ?? SHEETS[0]);

function syncFromHash(): void {
    active.value = readSheet();
}

onMounted(() => {
    window.addEventListener("hashchange", syncFromHash);
    if (!window.location.hash) window.location.hash = "1";
});
onBeforeUnmount(() => window.removeEventListener("hashchange", syncFromHash));
</script>

<template>
    <SheetFrame
        :index="String(active)"
        :title="current.label"
        :question="current.question"
        :note="current.note"
        :sheets="SHEETS.map((s) => ({ n: s.n, label: s.label }))"
        :active="active"
    >
        <component :is="current.comp" />
    </SheetFrame>
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
