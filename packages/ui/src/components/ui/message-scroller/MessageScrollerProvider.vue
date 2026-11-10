<script setup lang="ts">
import { provide } from "vue";
import {
    MessageScrollerContextKey,
    MessageScrollerItemContextKey,
    useMessageScrollerController,
} from "@/composables/messageScroller";
import type { MessageScrollerProviderProps } from "@/lib/messageScrollerTypes";

const props = withDefaults(defineProps<MessageScrollerProviderProps>(), {
    autoScroll: false,
    defaultScrollPosition: "end",
});

const { context, registerMessage } = useMessageScrollerController({
    autoScroll: props.autoScroll,
    defaultScrollPosition: props.defaultScrollPosition,
    scrollEdgeThreshold: props.scrollEdgeThreshold,
    scrollPreviousItemPeek: props.scrollPreviousItemPeek,
    scrollMargin: props.scrollMargin,
    // BL-316 第二步：用 getter 传，内容变化时要读到**最新**的声明行数（props 是响应式的）。
    projectedItemCount: () => props.sourceItemCount,
});

provide(MessageScrollerContextKey, context);
provide(MessageScrollerItemContextKey, registerMessage);

// PLAN-0760 / BL-556：父组件（MessageList）在 prepend 前声明「下一帧是 prepend」。
defineExpose({
    setPendingPrepend: context.setPendingPrepend,
    getPendingPrepend: context.getPendingPrepend,
});
</script>

<template>
    <slot />
</template>
