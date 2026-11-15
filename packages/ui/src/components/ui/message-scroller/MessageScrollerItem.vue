<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useMessageScrollerItemContext } from "@/composables/messageScroller";

const props = defineProps<{
    messageId?: string;
    scrollAnchor?: boolean;
    class?: string;
    /**
     * task-179：该行的已知真实高度（px）。给了就绑成内联 `contain-intrinsic-size: auto <h>px`，
     * 覆盖类里的 `auto 10rem`（160 px）—— 占位 ≈ 真实 ⇒ 行重测量不再产生尺寸差，
     * 浏览器滚动锚定也就无可补偿（`task-170` E2：改占位 160→662 后 474 px 位移全消失）。
     * 不给（没测过 / 非虚拟化）时行为与改动前逐字节一致。
     */
    intrinsicHeight?: number;
}>();

const registerMessage = useMessageScrollerItemContext(),
    elementRef = ref<HTMLDivElement | null>(null);

/** 只在拿到**有效**高度时才写内联样式：NaN/0/负数会让占位塌成 0，比 160 更糟。 */
const placeholderStyle = computed<{ containIntrinsicSize: string } | undefined>(() => {
    const height = props.intrinsicHeight;
    if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return undefined;
    return { containIntrinsicSize: `auto ${Math.round(height)}px` };
});

watch(
    [() => props.messageId, () => elementRef.value],
    ([messageId, element], [, prevElement]) => {
        if (messageId) {
            registerMessage(messageId, element, prevElement);
        }
    },
    { immediate: true, flush: "post" },
);
</script>

<template>
    <div
        ref="elementRef"
        data-slot="message-scroller-item"
        :data-message-id="props.messageId"
        :data-scroll-anchor="props.scrollAnchor ? 'true' : 'false'"
        :style="placeholderStyle"
        :class="[
            'min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]',
            props.class,
        ]"
    >
        <slot />
    </div>
</template>
