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
</script>

<template>
    <slot />
</template>
