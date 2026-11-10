<script lang="ts" setup>
import type { HTMLAttributes } from "vue";
import { useI18n } from "vue-i18n";
import { cn } from "@/lib/utils";

const props = defineProps<{
    class?: HTMLAttributes["class"];
}>();

// 上游 shadcn-vue 的 aria-label 是英文字面量；i18n 门（PLAN-0725）要求走 t()。
const { t } = useI18n();
</script>

<template>
    <nav :aria-label="t('common.breadcrumb')" data-slot="breadcrumb" :class="cn('', props.class)">
        <slot />
    </nav>
</template>
