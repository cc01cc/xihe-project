import { ref, shallowRef, triggerRef } from 'vue'
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
} from '@/lib/messageScrollerTypes'
import { areScrollStatesEqual, createMessageScrollerStore, createMessageScrollerVisibilityStore } from './messageScrollerStores'

export interface UseMessageScrollerRefsOptions {
  autoScroll: boolean
  scrollEdgeThreshold: number
  scrollMargin: number
  scrollPreviousItemPeek: number
}

export type UseMessageScrollerRefsReturn = ReturnType<typeof useMessageScrollerRefs>

export function useMessageScrollerRefs({
  autoScroll,
  scrollEdgeThreshold = DEFAULT_SCROLL_EDGE_THRESHOLD,
  scrollMargin = DEFAULT_SCROLL_MARGIN,
  scrollPreviousItemPeek = DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK,
}: UseMessageScrollerRefsOptions) {
  const autoScrollRef = ref(autoScroll)
  const autoscrollingRef = ref(false)
  const autoscrollingTimeoutRef = ref<number | null>(null)
  const streamingTurnRef = ref<HTMLElement | null>(null)
  const contentRef = ref<HTMLDivElement | null>(null)
  const defaultScrollPositionAppliedRef = ref(false)
  const scrollEdgeThresholdRef = ref(scrollEdgeThreshold)
  const itemCountRef = ref(0)
  const firstItemRef = ref<HTMLElement | null>(null)
  const modeRef = ref<MessageScrollerMode>(
    autoScroll ? 'following-bottom' : 'free-scrolling',
  )
  const messageElementsRef = ref(new Map<string, HTMLElement>())
  const pendingScrollToMessageRef = ref<{
    messageId: string
    options?: MessageScrollerScrollOptions
  } | null>(null)
  const prependRestoreRef = ref<{
    element: HTMLElement
    viewportTop: number
  } | null>(null)
  const scrollPreviousItemPeekRef = ref(scrollPreviousItemPeek)
  const preserveScrollOnPrependRef = ref(true)
  const rootRef = ref<HTMLDivElement | null>(null)
  const scrollMarginRef = ref(scrollMargin)
  const pendingScrollFrameRef = ref<number | null>(null)
  const spacerGapRef = ref(0)
  const spacerHeightRef = ref(0)
  const spacerRef = ref<HTMLDivElement | null>(null)
  const stateFrameRef = ref<number | null>(null)
  const stateStoreRef = shallowRef<MessageScrollerStore<MessageScrollerScrollable> | null>(null)
  const viewportRef = ref<HTMLDivElement | null>(null)
  const visibilityFrameRef = ref<number | null>(null)
  const visibilityObserverRef = ref<IntersectionObserver | null>(null)
  const visibilityStoreRef = shallowRef<MessageScrollerVisibilityStore | null>(null)
  const visibleMessageIdsRef = ref(new Set<string>())
  const handledScrollAnchorsRef = ref(new WeakSet<HTMLElement>())

  if (stateStoreRef.value === null) {
    stateStoreRef.value = createMessageScrollerStore(
      EMPTY_MESSAGE_SCROLLER_SCROLLABLE,
      areScrollStatesEqual,
    )
  }

  if (visibilityStoreRef.value === null) {
    visibilityStoreRef.value = createMessageScrollerVisibilityStore()
  }

  // Vue 的 ref 是响应式的；通过 watch 或 getter 保持最新值。在 setup 中直接赋值即可。
  autoScrollRef.value = autoScroll
  scrollEdgeThresholdRef.value = scrollEdgeThreshold
  scrollMarginRef.value = scrollMargin
  scrollPreviousItemPeekRef.value = scrollPreviousItemPeek

  // 确保 store 引用稳定后触发一次 shallowRef 更新
  triggerRef(stateStoreRef)
  triggerRef(visibilityStoreRef)

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
  }
}
