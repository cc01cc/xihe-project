<script setup lang="ts">
import {
    AlertDialogContent,
    AlertDialogOverlay,
    AlertDialogPortal,
    useForwardPropsEmits,
    type AlertDialogContentEmits,
    type AlertDialogContentProps,
} from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { cn } from "@/lib/utils";
import { useAriaModal } from "@/components/ui/dialog/useAriaModal";
import { dialogWidthClass, type DialogWidthTier } from "@/components/ui/dialog/dialogWidths";

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(
    defineProps<
        AlertDialogContentProps & {
            class?: HTMLAttributes["class"];
            size?: "default" | "sm";
            /** 宽度档位（task-137）：确认类默认 confirm；宽度不再由 size 决定。 */
            width?: DialogWidthTier;
        }
    >(),
    {
        size: "default",
        width: "confirm",
    },
);
const emits = defineEmits<AlertDialogContentEmits>();

const delegatedProps = reactiveOmit(props, "class", "size", "width");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
// task-49：AlertDialogRoot 转发给 DialogRoot 时硬编码 `modal: true`
// （dist/AlertDialog/AlertDialogRoot.js）⇒ 这里读到的永远是 true；仍走同一条条件判据，
// 不写特例，将来 reka 若放开非模态 AlertDialog 自动正确。
const ariaModal = useAriaModal();
</script>

<template>
    <AlertDialogPortal>
        <AlertDialogOverlay
            data-slot="alert-dialog-overlay"
            class="data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 z-50"
        />
        <AlertDialogContent
            data-slot="alert-dialog-content"
            :data-size="size"
            :data-dialog-width="props.width"
            v-bind="{ ...$attrs, ...forwarded }"
            :aria-modal="ariaModal"
            :class="
                cn(
                    'data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 bg-popover text-popover-foreground ring-foreground/10 gap-4 rounded-xl p-4 ring-1 duration-100 group/alert-dialog-content max-w-[calc(100%-2rem)] fixed top-1/2 left-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 outline-none',
                    dialogWidthClass(props.width),
                    props.class,
                )
            "
        >
            <slot />
        </AlertDialogContent>
    </AlertDialogPortal>
</template>
