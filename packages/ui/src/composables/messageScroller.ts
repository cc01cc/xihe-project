import { onUnmounted, watch } from 'vue'
import {
  DEFAULT_SCROLL_EDGE_THRESHOLD,
  DEFAULT_SCROLL_MARGIN,
  DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK,
  EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE,
  type MessageScrollerContextValue,
  type MessageScrollerProviderProps,
  type MessageScrollerRegisterMessage,
  type MessageScrollerScrollable,
} from '@/lib/messageScrollerTypes'
import {
  getContentBottom,
  getElementTop,
  getElementViewportTop,
  getFirstVisibleMessageItem,
  getLastScrollAnchor,
  getMessageScrollerItems,
  getMessageScrollerScrollable,
  getMessageScrollerVisibilityState,
  getNewScrollAnchor,
  getUnanchoredScrollAnchor,
  hasMultipleNewScrollAnchors,
} from '@/lib/messageScrollerGeometry'
import { useMessageScrollerRefs } from './messageScrollerRefs'
import { useMessageScrollerCommands } from './messageScrollerCommands'

export {
  MessageScrollerContextKey,
  MessageScrollerItemContextKey,
  provideMessageScrollerContext,
  provideMessageScrollerItemContext,
  useMessageScroller,
  useMessageScrollerContext,
  useMessageScrollerItemContext,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from './messageScrollerVisibility'

export function useMessageScrollerController({
  autoScroll = false,
  defaultScrollPosition = 'end',
  scrollEdgeThreshold = DEFAULT_SCROLL_EDGE_THRESHOLD,
  scrollPreviousItemPeek = DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK,
  scrollMargin = DEFAULT_SCROLL_MARGIN,
}: MessageScrollerProviderProps) {
  const refs = useMessageScrollerRefs({
    autoScroll,
    scrollEdgeThreshold,
    scrollMargin,
    scrollPreviousItemPeek,
  })

  const {
    streamingTurnRef,
    autoScrollRef,
    autoscrollingRef,
    autoscrollingTimeoutRef,
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
    spacerRef,
    stateFrameRef,
    stateStore,
    viewportRef,
    visibilityFrameRef,
    visibilityObserverRef,
    visibilityStore,
    visibleMessageIdsRef,
    handledScrollAnchorsRef,
  } = refs

  const previousDefaultScrollPositionRef = { current: defaultScrollPosition }

  if (previousDefaultScrollPositionRef.current !== defaultScrollPosition) {
    previousDefaultScrollPositionRef.current = defaultScrollPosition
    defaultScrollPositionAppliedRef.value = false
  }

  function writeStateAttributes(state: MessageScrollerScrollable) {
    const root = rootRef.value
    const viewport = viewportRef.value
    const scrollable = [state.start && 'start', state.end && 'end']
      .filter(Boolean)
      .join(' ')
    const autoScrolling = autoscrollingRef.value

    for (const element of [root, viewport]) {
      if (!element) {
        continue
      }

      if (scrollable) {
        element.setAttribute('data-scrollable', scrollable)
      } else {
        element.removeAttribute('data-scrollable')
      }

      element.toggleAttribute('data-autoscrolling', autoScrolling)
    }
  }

  function reconcileFollowMode(scrollable: MessageScrollerScrollable) {
    if (
      autoScrollRef.value &&
      !scrollable.end &&
      modeRef.value !== 'settling-jump'
    ) {
      modeRef.value = 'following-bottom'
    } else if (
      modeRef.value === 'following-bottom' &&
      scrollable.end &&
      !autoscrollingRef.value
    ) {
      modeRef.value = 'free-scrolling'
    }
  }

  function commitScrollState() {
    const nextState = getMessageScrollerScrollable({
      content: contentRef.value,
      scrollEdgeThreshold: scrollEdgeThresholdRef.value,
      spacer: spacerRef.value,
      viewport: viewportRef.value,
    })

    reconcileFollowMode(nextState)
    writeStateAttributes(nextState)
    stateStore.value.setSnapshot(nextState)
  }

  function scheduleStateCommit() {
    if (stateFrameRef.value !== null) {
      return
    }

    stateFrameRef.value = window.requestAnimationFrame(() => {
      stateFrameRef.value = null
      commitScrollState()
    })
  }

  function scheduleVisibilitySync() {
    if (!visibilityStore.value.hasListeners()) {
      return
    }

    if (visibilityFrameRef.value !== null) {
      return
    }

    visibilityFrameRef.value = window.requestAnimationFrame(() => {
      visibilityFrameRef.value = null

      if (!visibilityStore.value.hasListeners()) {
        return
      }

      visibilityStore.value.setSnapshot(
        getMessageScrollerVisibilityState({
          content: contentRef.value,
          scrollMargin: scrollMarginRef.value,
          scrollPreviousItemPeek: scrollPreviousItemPeekRef.value,
          spacer: spacerRef.value,
          viewport: viewportRef.value,
          visibleMessageIds: visibleMessageIdsRef.value,
        }),
      )
    })
  }

  const {
    flushPendingScrollToMessage,
    reanchorToAnchoredMessage,
    scrollToElement,
    scrollToEnd,
    scrollToMessage,
    scrollToStart,
  } = useMessageScrollerCommands({
    refs,
    commitScrollState,
    scheduleStateCommit,
    scheduleVisibilitySync,
  })

  function restorePrependedAnchor() {
    const anchor = prependRestoreRef.value
    const viewport = viewportRef.value

    if (!anchor || !viewport || !anchor.element.isConnected) {
      return false
    }

    const nextViewportTop = getElementViewportTop(anchor.element, viewport)
    const delta = nextViewportTop - anchor.viewportTop

    if (Math.abs(delta) <= 0.5) {
      return false
    }

    viewport.scrollTop += delta
    anchor.viewportTop = getElementViewportTop(anchor.element, viewport)
    scheduleStateCommit()
    scheduleVisibilitySync()

    return true
  }

  function capturePrependAnchor() {
    const content = contentRef.value
    const viewport = viewportRef.value

    if (!content || !viewport) {
      prependRestoreRef.value = null
      return
    }

    const anchor = getFirstVisibleMessageItem({
      content,
      spacer: spacerRef.value,
      viewport,
    })

    prependRestoreRef.value = anchor
      ? {
          element: anchor,
          viewportTop: getElementViewportTop(anchor, viewport),
        }
      : null
  }

  function schedulePendingScrollToMessageFlush() {
    if (pendingScrollFrameRef.value !== null) {
      return
    }

    pendingScrollFrameRef.value = window.requestAnimationFrame(() => {
      pendingScrollFrameRef.value = null

      if (flushPendingScrollToMessage()) {
        capturePrependAnchor()
      }
    })
  }

  function applyDefaultScrollPosition() {
    if (
      !defaultScrollPosition ||
      defaultScrollPositionAppliedRef.value ||
      itemCountRef.value === 0
    ) {
      return false
    }

    let handled = false

    if (defaultScrollPosition === 'last-anchor') {
      const content = contentRef.value
      const viewport = viewportRef.value
      const anchor =
        content && viewport
          ? getLastScrollAnchor(
              getMessageScrollerItems(content, spacerRef.value),
            )
          : null

      if (!content || !viewport || !anchor) {
        handled = scrollToEnd({ behavior: 'auto' })
      } else {
        const anchorTop = getElementTop(anchor, viewport)
        const contentBottom = getContentBottom({
          content,
          spacer: spacerRef.value,
          viewport,
        })
        const lastTurnFits = contentBottom - anchorTop <= viewport.clientHeight

        handled = lastTurnFits
          ? scrollToEnd({ behavior: 'auto' })
          : scrollToElement(anchor, { align: 'start' }, { keepPreviousPeek: true })
      }
    } else {
      handled =
        defaultScrollPosition === 'end'
          ? scrollToEnd({ behavior: 'auto' })
          : scrollToStart({ behavior: 'auto' })
    }

    if (!handled) {
      return false
    }

    defaultScrollPositionAppliedRef.value = true

    return true
  }

  function handleContentChange() {
    const content = contentRef.value

    if (!content) {
      return
    }

    const items = getMessageScrollerItems(content, spacerRef.value)
    const previousItemCount = itemCountRef.value
    const previousFirstItem = firstItemRef.value

    itemCountRef.value = items.length
    firstItemRef.value = items[0] ?? null

    const reconcileScrollPosition = () => {
      if (flushPendingScrollToMessage()) {
        return
      }

      if (previousItemCount === 0) {
        if (applyDefaultScrollPosition()) {
          return
        }

        if (
          items.length > 0 &&
          autoScrollRef.value &&
          scrollToEnd({ behavior: 'auto' })
        ) {
          return
        }

        commitScrollState()
        scheduleVisibilitySync()
        return
      }

      const previousFirstItemIndex = previousFirstItem
        ? items.indexOf(previousFirstItem)
        : -1
      const didPrepend =
        preserveScrollOnPrependRef.value && previousFirstItemIndex > 0

      if (didPrepend) {
        restorePrependedAnchor()
        return
      }

      if (items.length > previousItemCount) {
        const anchor = getNewScrollAnchor(items, previousItemCount)

        if (anchor) {
          if (
            autoScrollRef.value &&
            modeRef.value === 'following-bottom' &&
            hasMultipleNewScrollAnchors(items, previousItemCount)
          ) {
            scrollToEnd({ behavior: 'auto' })
            return
          }

          scrollToElement(anchor, { align: 'start' }, { keepPreviousPeek: true })
          handledScrollAnchorsRef.value.add(anchor)
          return
        }
      }

      if (items.length === previousItemCount) {
        const anchor = getUnanchoredScrollAnchor(
          items,
          handledScrollAnchorsRef.value,
        )

        if (anchor) {
          scrollToElement(anchor, { align: 'start' }, { keepPreviousPeek: true })
          handledScrollAnchorsRef.value.add(anchor)
          return
        }
      }

      if (modeRef.value === 'following-bottom' && autoScrollRef.value) {
        scrollToEnd({ behavior: 'auto' })
      } else {
        commitScrollState()
        scheduleVisibilitySync()
      }
    }

    reconcileScrollPosition()
    capturePrependAnchor()
  }

  function handleResize() {
    if (modeRef.value === 'following-bottom' && autoScrollRef.value) {
      scrollToEnd({ behavior: 'auto' })
      return
    }

    if (reanchorToAnchoredMessage()) {
      return
    }

    scheduleStateCommit()
    scheduleVisibilitySync()
  }

  function observeVisibility() {
    const viewport = viewportRef.value

    if (!viewport || !visibilityStore.value.hasListeners()) {
      return
    }

    if (typeof IntersectionObserver === 'undefined') {
      scheduleVisibilitySync()
      return
    }

    if (!visibilityObserverRef.value) {
      visibilityObserverRef.value = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const messageId = (entry.target as HTMLElement).dataset.messageId

            if (!messageId) {
              continue
            }

            if (entry.isIntersecting) {
              visibleMessageIdsRef.value.add(messageId)
            } else {
              visibleMessageIdsRef.value.delete(messageId)
            }
          }

          scheduleVisibilitySync()
        },
        {
          root: viewport,
          rootMargin: `${-(
            scrollMarginRef.value + scrollPreviousItemPeekRef.value
          )}px 0px 0px 0px`,
          threshold: [0, 0.01, 0.5, 1],
        },
      )
    }

    messageElementsRef.value.forEach((element) => {
      visibilityObserverRef.value?.observe(element)
    })
    scheduleVisibilitySync()
  }

  function unobserveVisibility() {
    if (visibilityFrameRef.value !== null) {
      window.cancelAnimationFrame(visibilityFrameRef.value)
      visibilityFrameRef.value = null
    }

    visibilityObserverRef.value?.disconnect()
    visibilityObserverRef.value = null
    visibleMessageIdsRef.value.clear()
    visibilityStore.value.setSnapshot(EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE)
  }

  const registerMessage: MessageScrollerRegisterMessage = (
    messageId,
    element,
    removedElement,
  ) => {
    if (element) {
      messageElementsRef.value.set(messageId, element)
      visibilityObserverRef.value?.observe(element)
      scheduleVisibilitySync()

      if (pendingScrollToMessageRef.value?.messageId === messageId) {
        schedulePendingScrollToMessageFlush()
      }

      return
    }

    if (
      removedElement &&
      messageElementsRef.value.get(messageId) === removedElement
    ) {
      messageElementsRef.value.delete(messageId)
      visibleMessageIdsRef.value.delete(messageId)
      visibilityObserverRef.value?.unobserve(removedElement)
      scheduleVisibilitySync()
    }
  }

  function userScrollIntent() {
    if (
      modeRef.value === 'following-bottom' ||
      modeRef.value === 'anchored-to-message' ||
      modeRef.value === 'settling-jump'
    ) {
      streamingTurnRef.value = null
      modeRef.value = 'free-scrolling'
    }
  }

  function mirrorStateAttributes() {
    writeStateAttributes(stateStore.value.getSnapshot())
  }

  function setRootElement(element: HTMLDivElement | null) {
    rootRef.value = element

    if (element) {
      mirrorStateAttributes()
    }
  }

  function setViewportElement(element: HTMLDivElement | null) {
    viewportRef.value = element

    if (element) {
      mirrorStateAttributes()
    }
  }

  function setContentElement(element: HTMLDivElement | null) {
    contentRef.value = element
  }

  function setSpacerElement(element: HTMLDivElement | null) {
    spacerRef.value = element
  }

  function syncAfterScroll() {
    commitScrollState()
    scheduleVisibilitySync()
    capturePrependAnchor()
  }

  const context: MessageScrollerContextValue = {
    handleContentChange,
    handleResize,
    observeVisibility,
    preserveScrollOnPrependRef: preserveScrollOnPrependRef as unknown as { current: boolean },
    scrollToEnd,
    scrollToMessage,
    scrollToStart,
    setContentElement,
    setRootElement,
    setSpacerElement,
    setViewportElement,
    stateStore: stateStore.value,
    syncAfterScroll,
    unobserveVisibility,
    userScrollIntent,
    viewportRef: viewportRef as unknown as { current: HTMLDivElement | null },
    visibilityStore: visibilityStore.value,
  }

  watch(
    [() => autoScroll, () => defaultScrollPosition],
    () => {
      applyDefaultScrollPosition()
    },
    { flush: 'post' },
  )

  onUnmounted(() => {
    if (stateFrameRef.value !== null) {
      window.cancelAnimationFrame(stateFrameRef.value)
      stateFrameRef.value = null
    }

    if (visibilityFrameRef.value !== null) {
      window.cancelAnimationFrame(visibilityFrameRef.value)
      visibilityFrameRef.value = null
    }

    if (autoscrollingTimeoutRef.value !== null) {
      window.clearTimeout(autoscrollingTimeoutRef.value)
      autoscrollingTimeoutRef.value = null
    }

    if (pendingScrollFrameRef.value !== null) {
      window.cancelAnimationFrame(pendingScrollFrameRef.value)
      pendingScrollFrameRef.value = null
    }

    visibilityObserverRef.value?.disconnect()
    visibilityObserverRef.value = null
  })

  return {
    context,
    registerMessage,
  }
}
