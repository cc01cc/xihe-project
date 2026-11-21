<script setup lang="ts">
import { XIcon } from "@lucide/vue";

import {
    DialogClose,
    DialogContent,
    DialogPortal,
    useForwardPropsEmits,
    type DialogContentEmits,
    type DialogContentProps,
} from "reka-ui";
import type { HTMLAttributes } from "vue";
import { useI18n } from "vue-i18n";
import { reactiveOmit } from "@vueuse/core";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import SheetOverlay from "./SheetOverlay.vue";
import { useAriaModal } from "@/components/ui/dialog/useAriaModal";
import {
    sheetWidthClass,
    type DialogWidthTier,
    type SheetSide,
} from "@/components/ui/dialog/dialogWidths";

interface SheetContentProps extends DialogContentProps {
    class?: HTMLAttributes["class"];
    side?: SheetSide;
    showCloseButton?: boolean;
    /**
     * task-185：Sheet 宽度档位，取值与 Dialog 共用 dialogWidths.ts 的四档。
     * 默认 confirm(384) 与 vendor 原语历史行为等价；宽度只允许从档位表来，
     * 调用点不得再自带 `max-w-*`（静态门 dialogWidthSmVariants.spec.ts 已把 SheetContent 纳入判据）。
     */
    width?: DialogWidthTier;
}

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(defineProps<SheetContentProps>(), {
    side: "right",
    showCloseButton: true,
    width: "confirm",
});
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = reactiveOmit(props, "class", "side", "showCloseButton", "width");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
const { t } = useI18n();
// task-49：Sheet 也是 reka Dialog 原语 ⇒ 同一条条件产出（modal=false 不输出）。
const ariaModal = useAriaModal();
</script>

<template>
    <DialogPortal>
        <SheetOverlay />
        <DialogContent
            data-slot="sheet-content"
            :data-side="side"
            :data-sheet-width="props.width"
            :class="
                cn(
                    'bg-popover text-popover-foreground fixed z-50 flex flex-col gap-4 bg-clip-padding text-sm shadow-lg transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-open:animate-in data-open:fade-in-0 data-[side=bottom]:data-open:slide-in-from-bottom-10 data-[side=left]:data-open:slide-in-from-left-10 data-[side=right]:data-open:slide-in-from-right-10 data-[side=top]:data-open:slide-in-from-top-10 data-closed:animate-out data-closed:fade-out-0 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=left]:data-closed:slide-out-to-left-10 data-[side=right]:data-closed:slide-out-to-right-10 data-[side=top]:data-closed:slide-out-to-top-10',
                    sheetWidthClass(props.side, props.width),
                    props.class,
                )
            "
            v-bind="{ ...$attrs, ...forwarded }"
            :aria-modal="ariaModal"
        >
            <slot />

            <DialogClose v-if="showCloseButton" data-slot="sheet-close" as-child>
                <Button
                    variant="ghost"
                    class="absolute top-3 right-3"
                    data-testid="sheet-close"
                    size="icon-sm"
                >
                    <XIcon />
                    <span class="sr-only">{{ t("common.close") }}</span>
                </Button>
            </DialogClose>
        </DialogContent>
    </DialogPortal>
</template>
