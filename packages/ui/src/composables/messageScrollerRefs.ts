import { ref, shallowRef, triggerRef } from "vue";
import {
    DEFAULT_SCROLL_EDGE_THRESHOLD,
    DEFAULT_SCROLL_MARGIN,
    DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK,
    EMPTY_MESSAGE_SCROLLER_SCROLLABLE,
    type MessageScrollerMode,
    type MessageScrollerScrollable,
    type MessageScrollerScrollOptions,
    type MessageScrollerStore,
    type MessageScrollerVisibilityStore,
} from "@/lib/messageScrollerTypes";
import {
    areScrollStatesEqual,
    createMessageScrollerStore,
    createMessageScrollerVisibilityStore,
} from "./messageScrollerStores";

export interface UseMessageScrollerRefsOptions {
    autoScroll: boolean;
    scrollEdgeThreshold: number;
    scrollMargin: number;
    scrollPreviousItemPeek: number;
}

export type UseMessageScrollerRefsReturn = ReturnType<typeof useMessageScrollerRefs>;

export function useMessageScrollerRefs({
    autoScroll,
    scrollEdgeThreshold = DEFAULT_SCROLL_EDGE_THRESHOLD,
    scrollMargin = DEFAULT_SCROLL_MARGIN,
    scrollPreviousItemPeek = DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK,
}: UseMessageScrollerRefsOptions) {
    const autoScrollRef = ref(autoScroll),
        autoscrollingRef = ref(false),
        autoscrollingTimeoutRef = ref<number | null>(null),
        streamingTurnRef = ref<HTMLElement | null>(null),
        contentRef = ref<HTMLDivElement | null>(null),
        defaultScrollPositionAppliedRef = ref(false),
        scrollEdgeThresholdRef = ref(scrollEdgeThreshold),
        itemCountRef = ref(0),
        firstItemRef = ref<HTMLElement | null>(null),
        modeRef = ref<MessageScrollerMode>(autoScroll ? "following-bottom" : "free-scrolling"),
        messageElementsRef = ref(new Map<string, HTMLElement>()),
        pendingScrollToMessageRef = ref<{
            messageId: string;
            options?: MessageScrollerScrollOptions;
        } | null>(null),
        prependRestoreRef = ref<{
            element: HTMLElement;
            viewportTop: number;
        } | null>(null),
        scrollPreviousItemPeekRef = ref(scrollPreviousItemPeek),
        preserveScrollOnPrependRef = ref(true),
        rootRef = ref<HTMLDivElement | null>(null),
        scrollMarginRef = ref(scrollMargin),
        pendingScrollFrameRef = ref<number | null>(null),
        spacerGapRef = ref(0),
        spacerHeightRef = ref(0),
        spacerRef = ref<HTMLDivElement | null>(null),
        stateFrameRef = ref<number | null>(null),
        stateStoreRef = shallowRef<MessageScrollerStore<MessageScrollerScrollable> | null>(null),
        viewportRef = ref<HTMLDivElement | null>(null),
        visibilityFrameRef = ref<number | null>(null),
        visibilityObserverRef = ref<IntersectionObserver | null>(null),
        visibilityStoreRef = shallowRef<MessageScrollerVisibilityStore | null>(null),
        visibleMessageIdsRef = ref(new Set<string>()),
        handledScrollAnchorsRef = ref(new WeakSet<HTMLElement>());

    if (stateStoreRef.value === null) {
        stateStoreRef.value = createMessageScrollerStore(
            EMPTY_MESSAGE_SCROLLER_SCROLLABLE,
            areScrollStatesEqual,
        );
    }

    if (visibilityStoreRef.value === null) {
        visibilityStoreRef.value = createMessageScrollerVisibilityStore();
    }

    // Vue 的 ref 是响应式的；通过 watch 或 getter 保持最新值。在 setup 中直接赋值即可。
    autoScrollRef.value = autoScroll;
    scrollEdgeThresholdRef.value = scrollEdgeThreshold;
    scrollMarginRef.value = scrollMargin;
    scrollPreviousItemPeekRef.value = scrollPreviousItemPeek;

    // 确保 store 引用稳定后触发一次 shallowRef 更新
    triggerRef(stateStoreRef);
    triggerRef(visibilityStoreRef);

    return {
        autoScrollRef,
        autoscrollingRef,
        autoscrollingTimeoutRef,
        streamingTurnRef,
        contentRef,
        defaultScrollPositionAppliedRef,
        firstItemRef,
        itemCountRef,
        messageElementsRef,
        modeRef,
        pendingScrollFrameRef,
        pendingScrollToMessageRef,
        prependRestoreRef,
        preserveScrollOnPrependRef,
        rootRef,
        scrollEdgeThresholdRef,
        scrollMarginRef,
        scrollPreviousItemPeekRef,
        spacerGapRef,
        spacerHeightRef,
        spacerRef,
        stateFrameRef,
        stateStore: stateStoreRef as { value: MessageScrollerStore<MessageScrollerScrollable> },
        viewportRef,
        visibilityFrameRef,
        visibilityObserverRef,
        visibilityStore: visibilityStoreRef as { value: MessageScrollerVisibilityStore },
        visibleMessageIdsRef,
        handledScrollAnchorsRef,
    };
}
