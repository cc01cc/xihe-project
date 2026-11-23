<script setup lang="ts">
import type { ComboboxContentEmits, ComboboxContentProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { cn } from "@/lib/utils";
import { ComboboxContent, ComboboxPortal, useForwardPropsEmits } from "reka-ui";

defineOptions({
    inheritAttrs: false,
});

const props = withDefaults(
    defineProps<ComboboxContentProps & { class?: HTMLAttributes["class"] }>(),
    {
        // task-152：与 vendor SelectContent 同契约 —— popper + align start + sideOffset 4。
        // align 曾是 center：popper 定位下居中对齐会让弹层相对触发器左右各飘一半，长选项被裁在屏幕外。
        position: "popper",
        align: "start",
        sideOffset: 4,
    },
);
const emits = defineEmits<ComboboxContentEmits>();

const delegatedProps = reactiveOmit(props, "class");
const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
    <ComboboxPortal>
        <ComboboxContent
            data-slot="combobox-content"
            v-bind="{ ...$attrs, ...forwarded }"
            :class="
                cn(
                    // task-152：宽度跟触发器（w- 与 min-w- 都用同一个 reka 变量），高度上限 = min(18rem, 可用视口高)，
                    // 超出改滚动；删掉未定义的 cn-menu-translucent（VENDOR.md 明写「惰性类名」）与 overflow-hidden
                    // ——后者会把 ComboboxViewport 的 overflow-y-auto 吃掉，超过 8 项就永远看不到下面。
                    // task-926：与 SelectContent 同步锁死横向溢出（内容固定跟触发器宽，p-1 + 内部 padding 曾让 scrollW 大于 clientW，
                    // 浏览器把 overflow-x 变成 auto ⇒ 列表底部出现横向滚动条）。纵向仍可滚动。
                    'bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 ring-foreground/10 *:data-[slot=input-group]:bg-input/30 *:data-[slot=input-group]:border-input/30 max-h-[min(18rem,var(--reka-combobox-content-available-height))] max-w-(--reka-combobox-content-available-width) overflow-x-hidden overflow-y-auto rounded-lg p-1 shadow-md ring-1 duration-100 *:data-[slot=input-group]:m-1 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:h-8 *:data-[slot=input-group]:shadow-none data-[side=inline-start]:slide-in-from-right-2 data-[side=inline-end]:slide-in-from-left-2 cn-menu-target group/combobox-content z-[var(--z-popover)] w-(--reka-combobox-trigger-width) min-w-(--reka-combobox-trigger-width)',
                    props.class,
                )
            "
        >
            <slot />
        </ComboboxContent>
    </ComboboxPortal>
</template>
