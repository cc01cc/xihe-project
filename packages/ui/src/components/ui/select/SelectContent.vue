<script setup lang="ts">
import type { SelectContentEmits, SelectContentProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { cn } from "@/lib/utils";
import { SelectContent, SelectPortal, SelectViewport, useForwardPropsEmits } from "reka-ui";
import { SelectScrollDownButton, SelectScrollUpButton } from ".";

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(
    defineProps<SelectContentProps & { class?: HTMLAttributes["class"] }>(),
    {
        // task-152：默认走 popper（贴触发器下方）而不是 item-aligned（以选中项为锚，会向上盖住字段标签）。
        position: "popper",
        align: "start",
        sideOffset: 4,
    },
);
const emits = defineEmits<SelectContentEmits>();

const delegatedProps = reactiveOmit(props, "class");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
    <SelectPortal>
        <SelectContent
            data-slot="select-content"
            :data-align-trigger="position === 'item-aligned'"
            v-bind="{ ...$attrs, ...forwarded }"
            :class="
                cn(
                    'bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 w-(--reka-select-trigger-width) rounded-lg p-1 shadow-md ring-1 duration-100 data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 cn-menu-target relative z-[var(--z-select)] max-h-[min(18rem,var(--reka-select-content-available-height))] origin-(--reka-select-content-transform-origin) overflow-y-auto data-[align-trigger=true]:animate-none',
                    props.class,
                )
            "
        >
            <SelectScrollUpButton />
            <SelectViewport
                tabindex="-1"
                :data-position="position"
                :class="
                    cn(
                        'data-[position=popper]:w-full data-[position=popper]:min-w-(--reka-select-trigger-width)',
                    )
                "
            >
                <slot />
            </SelectViewport>
            <SelectScrollDownButton />
        </SelectContent>
    </SelectPortal>
</template>
