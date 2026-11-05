<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useMessageScrollerContext } from "@/composables/messageScroller";

const props = defineProps<{
    class?: string;
    spacerClassName?: string;
}>();

const { handleContentChange, handleResize, setContentElement, setSpacerElement } =
    useMessageScrollerContext();

const contentEl = ref<HTMLDivElement | null>(null),
    spacerEl = ref<HTMLDivElement | null>(null);

watch(contentEl, (el) => {
    setContentElement(el);
    // `onMounted` 里首次 handleContentChange 时 contentRef 可能尚未写入（template ref 的
    // watch 回调晚于 mounted），provider 的 itemCount/首项会停在 0；下一次 DOM 变更（例如
    // 加载更早）就被当成"首次内容"，走 defaultScrollPosition=last-anchor 直接贴底。
    // 元素一可用就立刻登记一次，保证 prepend 分支拿到正确的 previousItemCount。
    if (el) handleContentChange();
});

watch(spacerEl, (el) => {
    setSpacerElement(el);
    if (el) handleContentChange();
});

let mutationObserver: MutationObserver | null = null,
    resizeObserver: ResizeObserver | null = null;

onMounted(() => {
    if (contentEl.value) {
        handleContentChange();

        if (typeof MutationObserver !== "undefined") {
            mutationObserver = new MutationObserver(handleContentChange);
            mutationObserver.observe(contentEl.value, { childList: true });
        }

        if (typeof ResizeObserver !== "undefined") {
            resizeObserver = new ResizeObserver(handleResize);
            resizeObserver.observe(contentEl.value);
        }
    }
});

onUnmounted(() => {
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
});
</script>

<template>
    <div
        ref="contentEl"
        data-slot="message-scroller-content"
        role="log"
        aria-relevant="additions"
        :class="['flex h-max min-h-full flex-col gap-8', props.class]"
    >
        <slot />
        <div
            ref="spacerEl"
            aria-hidden="true"
            data-message-scroller-spacer=""
            hidden
            :class="props.spacerClassName"
        />
    </div>
</template>
