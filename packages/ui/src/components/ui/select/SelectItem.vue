<script setup lang="ts">
import type { SelectItemProps } from "reka-ui";

import type { HTMLAttributes } from "vue";
import { CheckIcon } from "@lucide/vue";
import { reactiveOmit } from "@vueuse/core";
import { computed, onBeforeUnmount, onMounted, ref, useAttrs } from "vue";
import { cn } from "@/lib/utils";
import { SelectItem, SelectItemIndicator, SelectItemText, useForwardProps } from "reka-ui";

const props = defineProps<SelectItemProps & { class?: HTMLAttributes["class"] }>();
const attrs = useAttrs();

const delegatedProps = reactiveOmit(props, "class");
const forwardedProps = useForwardProps(delegatedProps);

/**
 * task-152：条目文本单行截断（truncate），并用原生 title 兜底显示全文。
 * 兜底只在**调用方没传 title** 时生效：那时 title 取实际渲染文本（异步渲染的选项文本也跟着更新）。
 * 调用方自己给了 title 就以它为准，并且**不建 MutationObserver**（按需观察，避免每个条目无条件挂 observer）。
 */
const labelEl = ref<HTMLElement | null>(null);
const renderedLabel = ref("");
let labelObserver: MutationObserver | null = null;

const explicitTitle = computed(() => {
    const own = attrs.title;
    return typeof own === "string" && own.length > 0 ? own : "";
});

const title = computed(() => explicitTitle.value || renderedLabel.value || undefined);

onMounted(() => {
    if (explicitTitle.value) return;
    const el = labelEl.value;
    if (!el) return;
    const sync = () => {
        renderedLabel.value = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    };
    sync();
    labelObserver = new MutationObserver(sync);
    labelObserver.observe(el, { childList: true, characterData: true, subtree: true });
});

onBeforeUnmount(() => {
    labelObserver?.disconnect();
    labelObserver = null;
});
</script>

<template>
    <SelectItem
        data-slot="select-item"
        v-bind="forwardedProps"
        :title="title"
        :class="
            cn(
                'focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm [&_svg:not([class*=size-])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2 relative flex w-full min-w-0 cursor-default items-center outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
                props.class,
            )
        "
    >
        <span class="pointer-events-none absolute right-2 flex size-4 items-center justify-center">
            <SelectItemIndicator>
                <slot name="indicator-icon">
                    <CheckIcon class="pointer-events-none" />
                </slot>
            </SelectItemIndicator>
        </span>

        <SelectItemText class="min-w-0 flex-1">
            <span ref="labelEl" class="block min-w-0 truncate">
                <slot />
            </span>
        </SelectItemText>
    </SelectItem>
</template>
