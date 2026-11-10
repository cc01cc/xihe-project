<script setup lang="ts">
import type { HTMLAttributes } from "vue";

import { PanelLeftIcon } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useSidebar } from "./utils";

const props = defineProps<{
    class?: HTMLAttributes["class"];
}>();

const { toggleSidebar } = useSidebar();

// 与 SidebarRail 同一个可读标签，别只把 attribute 汉化而把 sr-only 留在英文。
const { t } = useI18n();
</script>

<template>
    <Button
        data-sidebar="trigger"
        data-slot="sidebar-trigger"
        variant="ghost"
        size="icon-sm"
        :class="cn('', props.class)"
        @click="toggleSidebar"
    >
        <PanelLeftIcon class="cn-rtl-flip" />
        <span class="sr-only">{{ t("sidebar.toggle") }}</span>
    </Button>
</template>
