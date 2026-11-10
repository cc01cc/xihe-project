<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { useI18n } from "vue-i18n";
import { cn } from "@/lib/utils";
import { useSidebar } from "./utils";

const props = defineProps<{
    class?: HTMLAttributes["class"];
}>();

const { toggleSidebar } = useSidebar();

// 上游 shadcn-vue 把 aria-label / title 写成英文字面量；i18n 门（PLAN-0725/0726）要求走 t()。
const { t } = useI18n();
</script>

<template>
    <button
        data-sidebar="rail"
        data-slot="sidebar-rail"
        :aria-label="t('sidebar.toggle')"
        :tabindex="-1"
        :title="t('sidebar.toggle')"
        :class="
            cn(
                'hover:after:bg-sidebar-border absolute inset-y-0 z-20 hidden w-4 transition-all ease-linear group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:start-1/2 after:w-0.5 sm:flex ltr:-translate-x-1/2 rtl:-translate-x-1/2',
                'in-data-[side=left]:cursor-w-resize in-data-[side=right]:cursor-e-resize',
                '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
                'group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar',
                '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
                '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
                props.class,
            )
        "
        @click="toggleSidebar"
    >
        <slot />
    </button>
</template>
