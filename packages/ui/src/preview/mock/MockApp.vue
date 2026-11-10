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
        note: "shadcn Sidebar 分组 + lucide 图标 + 2px 选中条 + Breadcrumb + 内容列宽上限",
        comp: S1SettingsAfter,
    },
    {
        n: 2,
        label: "改造前 / 改造后",
        note: "左＝现网真实组件（SettingsSidebar + 手拼面包屑）；右＝改造后",
        comp: S2BeforeAfter,
    },
    {
        n: 3,
        label: "左栏分组折叠",
        note: "Collapsible 折起「域」、展开「我的资源」——两态并排",
        comp: S3Collapse,
    },
    {
        n: 4,
        label: "全局导航条双态",
        note: "同一 Sidebar：48px 纯图标 ↔ 256px 图标+文字+模块名",
        comp: S4GlobalNav,
    },
    {
        n: 5,
        label: "工作区三栏 + sash",
        note: "列边界 hover 显示竖向三点 ⋮ + 高亮线",
        comp: S5WorkspaceSash,
    },
    {
        n: 6,
        label: "空态 + 权限不足",
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
        :note="current.note"
        :sheets="SHEETS.map((s) => ({ n: s.n, label: s.label }))"
        :active="active"
    >
        <component :is="current.comp" />
    </SheetFrame>
</template>
