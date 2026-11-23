<script setup lang="ts">
import type { SelectValueProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { cn } from "@/lib/utils";
import { SelectValue } from "reka-ui";

const props = defineProps<SelectValueProps & { class?: HTMLAttributes["class"] }>();
const delegatedProps = reactiveOmit(props, "class");
</script>

<template>
    <SelectValue
        data-slot="select-value"
        v-bind="delegatedProps"
        :class="cn('min-w-0 flex-1 truncate text-left', props.class)"
    >
        <slot />
    </SelectValue>
</template>
