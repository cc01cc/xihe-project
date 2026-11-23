<script setup lang="ts">
import type { ComboboxTriggerProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { cn } from "@/lib/utils";
import { ComboboxTrigger, useForwardProps } from "reka-ui";

const props = defineProps<ComboboxTriggerProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = reactiveOmit(props, "class");

const forwarded = useForwardProps(delegatedProps);
</script>

<template>
    <ComboboxTrigger
        data-slot="combobox-trigger"
        v-bind="forwarded"
        :class="
            cn(
                // task-926：触发器基座自带「可收缩 + 内容省略」，调用点无需逐个补 min-w-0（showcase 由 SearchableCombobox 的 w-full 覆写）。
                'min-w-0 max-w-full overflow-hidden [&_svg:not([class*=size-])]:size-4',
                props.class,
            )
        "
        tabindex="0"
    >
        <slot />
    </ComboboxTrigger>
</template>
