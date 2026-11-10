import { onUnmounted, watch } from "vue";
import {
    DEFAULT_SCROLL_EDGE_THRESHOLD,
    DEFAULT_SCROLL_MARGIN,
    DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK,
    EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE,
    type MessageScrollerContextValue,
    type MessageScrollerProviderProps,
    type MessageScrollerRegisterMessage,
    type MessageScrollerScrollable,
} from "@/lib/messageScrollerTypes";
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
} from "@/lib/messageScrollerGeometry";
import { useMessageScrollerRefs } from "./messageScrollerRefs";
import { useMessageScrollerCommands } from "./messageScrollerCommands";

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
} from "./messageScrollerVisibility";

/**
 * BL-316 第二步：控制器选项 = Provider props + 投影声明。
 *
 * `projectedItemCount` 用 getter 而不是普通值：它来自父组件的响应式状态
 * （`MessageList` 的 `rows.length`），每次内容变化都要读到**最新**值。
 */
export interface MessageScrollerControllerOptions extends MessageScrollerProviderProps {
    /** 投影声明：内容 DOM 所投影的底层完整条目数；undefined = 不是投影。 */
    projectedItemCount?: () => number | undefined;
}

export function useMessageScrollerController({
    autoScroll = false,
    defaultScrollPosition = "end",
    scrollEdgeThreshold = DEFAULT_SCROLL_EDGE_THRESHOLD,
    scrollPreviousItemPeek = DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK,
    scrollMargin = DEFAULT_SCROLL_MARGIN,
    projectedItemCount,
}: MessageScrollerControllerOptions) {
    const refs = useMessageScrollerRefs({
        autoScroll,
        scrollEdgeThreshold,
        scrollMargin,
        scrollPreviousItemPeek,
    });

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
        pendingPrependRef,
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
    } = refs;

    const previousDefaultScrollPositionRef = { current: defaultScrollPosition };

    /** BL-316 第二步：上一次看到的"底层完整条目数"（见 `handleContentChange` 的投影判定）。 */
    const previousProjectedCountRef = { current: undefined as number | undefined };

    if (previousDefaultScrollPositionRef.current !== defaultScrollPosition) {
        previousDefaultScrollPositionRef.current = defaultScrollPosition;
        defaultScrollPositionAppliedRef.value = false;
    }

    function writeStateAttributes(state: MessageScrollerScrollable) {
        const root = rootRef.value,
            viewport = viewportRef.value,
            scrollable = [state.start && "start", state.end && "end"].filter(Boolean).join(" "),
            autoScrolling = autoscrollingRef.value;

        for (const element of [root, viewport]) {
            if (!element) {
                continue;
            }

            if (scrollable) {
                element.setAttribute("data-scrollable", scrollable);
            } else {
                element.removeAttribute("data-scrollable");
            }

            element.toggleAttribute("data-autoscrolling", autoScrolling);
        }
    }

    function reconcileFollowMode(scrollable: MessageScrollerScrollable) {
        if (autoScrollRef.value && !scrollable.end && modeRef.value !== "settling-jump") {
            modeRef.value = "following-bottom";
        } else if (
            modeRef.value === "following-bottom" &&
            scrollable.end &&
            !autoscrollingRef.value
        ) {
            modeRef.value = "free-scrolling";
        }
    }

    function commitScrollState() {
        const nextState = getMessageScrollerScrollable({
            content: contentRef.value,
            scrollEdgeThreshold: scrollEdgeThresholdRef.value,
            spacer: spacerRef.value,
            viewport: viewportRef.value,
        });

        reconcileFollowMode(nextState);
        writeStateAttributes(nextState);
        stateStore.value.setSnapshot(nextState);
    }

    function scheduleStateCommit() {
        if (stateFrameRef.value !== null) {
            return;
        }

        stateFrameRef.value = window.requestAnimationFrame(() => {
            stateFrameRef.value = null;
            commitScrollState();
        });
    }

    function scheduleVisibilitySync() {
        if (!visibilityStore.value.hasListeners()) {
            return;
        }

        if (visibilityFrameRef.value !== null) {
            return;
        }

        visibilityFrameRef.value = window.requestAnimationFrame(() => {
            visibilityFrameRef.value = null;

            if (!visibilityStore.value.hasListeners()) {
                return;
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
            );
        });
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
    });

    function restorePrependedAnchor() {
        const anchor = prependRestoreRef.value,
            viewport = viewportRef.value;

        if (!anchor || !viewport || !anchor.element.isConnected) {
            // R4：无有效锚点 ⇒ 本次 prepend 声明已消费，清零避免污染后续 childList 变化。
            pendingPrependRef.value = false;
            return false;
        }

        const nextViewportTop = getElementViewportTop(anchor.element, viewport),
            delta = nextViewportTop - anchor.viewportTop;

        if (Math.abs(delta) <= 0.5) {
            return false;
        }

        viewport.scrollTop += delta;
        anchor.viewportTop = getElementViewportTop(anchor.element, viewport);
        scheduleStateCommit();
        scheduleVisibilitySync();

        return true;
    }

    function capturePrependAnchor() {
        const content = contentRef.value,
            viewport = viewportRef.value;

        if (!content || !viewport) {
            prependRestoreRef.value = null;
            return;
        }

        const anchor = getFirstVisibleMessageItem({
            content,
            spacer: spacerRef.value,
            viewport,
        });

        prependRestoreRef.value = anchor
            ? {
                  element: anchor,
                  viewportTop: getElementViewportTop(anchor, viewport),
              }
            : null;
    }

    function schedulePendingScrollToMessageFlush() {
        if (pendingScrollFrameRef.value !== null) {
            return;
        }

        pendingScrollFrameRef.value = window.requestAnimationFrame(() => {
            pendingScrollFrameRef.value = null;

            if (flushPendingScrollToMessage()) {
                capturePrependAnchor();
            }
        });
    }

    function applyDefaultScrollPosition() {
        if (
            !defaultScrollPosition ||
            defaultScrollPositionAppliedRef.value ||
            itemCountRef.value === 0
        ) {
            return false;
        }

        let handled = false;

        if (defaultScrollPosition === "last-anchor") {
            const content = contentRef.value,
                viewport = viewportRef.value,
                anchor =
                    content && viewport
                        ? getLastScrollAnchor(getMessageScrollerItems(content, spacerRef.value))
                        : null;

            if (!content || !viewport || !anchor) {
                handled = scrollToEnd({ behavior: "auto" });
            } else {
                const anchorTop = getElementTop(anchor, viewport),
                    contentBottom = getContentBottom({
                        content,
                        spacer: spacerRef.value,
                        viewport,
                    }),
                    lastTurnFits = contentBottom - anchorTop <= viewport.clientHeight;

                handled = lastTurnFits
                    ? scrollToEnd({ behavior: "auto" })
                    : scrollToElement(anchor, { align: "start" }, { keepPreviousPeek: true });
            }
        } else {
            handled =
                defaultScrollPosition === "end"
                    ? scrollToEnd({ behavior: "auto" })
                    : scrollToStart({ behavior: "auto" });
        }

        if (!handled) {
            return false;
        }

        defaultScrollPositionAppliedRef.value = true;

        return true;
    }

    function handleContentChange() {
        const content = contentRef.value;

        if (!content) {
            return;
        }

        // 只统计真正的消息行：MessageList 顶部还有「加载更早」按钮、截断提示、窗口占位等
        // 兄弟节点；把它们算进 items 会让 prepend 检测失效（首个 child 永远是按钮 ⇒
        // previousFirstItemIndex 恒为 0 ⇒ didPrepend=false，provider 改用 getNewScrollAnchor
        // 把列表滚到某条消息，实测中间位置 prepend 会直接跳底 4k px）。
        const items = getMessageScrollerItems(content, spacerRef.value).filter(
                (item) => item.dataset.messageId,
            ),
            previousItemCount = itemCountRef.value,
            previousFirstItem = firstItemRef.value,
            /**
             * BL-316 第二步 —— 判定这次 DOM 变化是不是**窗口换页**。
             *
             * 判据是**数据层的事实**（`MessageList` 声明的 `sourceItemCount` = 全部行数），不是
             * 从 DOM 猜 itemCount 差值：窗口换页时首行/末行都会变，但底层行数不变；真新消息到达时
             * 行数一定变。两者在 DOM 计数上不可区分，在数据层声明上可区分。
             */
            projectedCount = projectedItemCount?.(),
            previousProjectedCount = previousProjectedCountRef.current,
            projectionOnly =
                projectedCount !== undefined &&
                previousProjectedCount !== undefined &&
                projectedCount === previousProjectedCount;

        previousProjectedCountRef.current = projectedCount;
        itemCountRef.value = items.length;
        firstItemRef.value = items[0] ?? null;

        const reconcileScrollPosition = () => {
            if (flushPendingScrollToMessage()) {
                return;
            }

            // 窗口换页（数据没变、只是渲染了另一段）：**位置由用户/浏览器掌握，一律不动**。
            //
            // BL-340：这里**不再**调 `scrollToEnd()`。换页是"窗口投影变化"，与"有没有新内容"
            // 无关；旧实现在本分支里"若在贴底跟随就 scrollToEnd"，而 `scrollToEnd()` 又会把
            // `modeRef` 写回 `following-bottom`（见 `messageScrollerCommands.ts`）⇒ 换页 ↔ 贴底
            // 闭环自激：用户在底部附近上滚（wheel 已发出、scroll 处理尚未改模式）会被立刻拽回底部，
            // 实测 8×500px 上滚里应用侧写了 40 次 `scrollTop`，40×2000px 判据因此一直红。
            // 贴底跟随只属于"数据变化"路径（下面的 `items.length` 分支），不属于换页。
            if (projectionOnly) {
                commitScrollState();
                scheduleVisibilitySync();
                return;
            }

            if (previousItemCount === 0) {
                if (applyDefaultScrollPosition()) {
                    return;
                }

                if (items.length > 0 && autoScrollRef.value && scrollToEnd({ behavior: "auto" })) {
                    return;
                }

                commitScrollState();
                scheduleVisibilitySync();
                return;
            }

            const previousFirstItemIndex = previousFirstItem
                    ? items.indexOf(previousFirstItem)
                    : -1,
                didPrepend =
                    preserveScrollOnPrependRef.value &&
                    (previousFirstItemIndex > 0 || pendingPrependRef.value === true);
            if (didPrepend) {
                // R4（评审必做）：**消费即清** —— 标志只对「下一帧内容变化」有效。
                // 不清的话，一次 prepend 之后每次 childList 变化都会被判成 prepend，
                // 走 restorePrependedAnchor() ⇒ 新消息到达时的贴底跟随被截断。
                pendingPrependRef.value = false;
                restorePrependedAnchor();
                return;
            }

            if (items.length > previousItemCount) {
                const anchor = getNewScrollAnchor(items, previousItemCount);

                if (anchor) {
                    if (
                        autoScrollRef.value &&
                        modeRef.value === "following-bottom" &&
                        hasMultipleNewScrollAnchors(items, previousItemCount)
                    ) {
                        scrollToEnd({ behavior: "auto" });
                        return;
                    }

                    scrollToElement(anchor, { align: "start" }, { keepPreviousPeek: true });
                    handledScrollAnchorsRef.value.add(anchor);
                    return;
                }
            }

            if (items.length === previousItemCount) {
                const anchor = getUnanchoredScrollAnchor(items, handledScrollAnchorsRef.value);

                if (anchor) {
                    scrollToElement(anchor, { align: "start" }, { keepPreviousPeek: true });
                    handledScrollAnchorsRef.value.add(anchor);
                    return;
                }
            }

            if (modeRef.value === "following-bottom" && autoScrollRef.value) {
                scrollToEnd({ behavior: "auto" });
            } else {
                commitScrollState();
                scheduleVisibilitySync();
            }
        };

        reconcileScrollPosition();
        capturePrependAnchor();
    }

    function handleResize() {
        if (modeRef.value === "following-bottom" && autoScrollRef.value) {
            scrollToEnd({ behavior: "auto" });
            return;
        }

        if (reanchorToAnchoredMessage()) {
            return;
        }

        scheduleStateCommit();
        scheduleVisibilitySync();
    }

    function observeVisibility() {
        const viewport = viewportRef.value;

        if (!viewport || !visibilityStore.value.hasListeners()) {
            return;
        }

        if (typeof IntersectionObserver === "undefined") {
            scheduleVisibilitySync();
            return;
        }

        if (!visibilityObserverRef.value) {
            visibilityObserverRef.value = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        const messageId = (entry.target as HTMLElement).dataset.messageId;

                        if (!messageId) {
                            continue;
                        }

                        if (entry.isIntersecting) {
                            visibleMessageIdsRef.value.add(messageId);
                        } else {
                            visibleMessageIdsRef.value.delete(messageId);
                        }
                    }

                    scheduleVisibilitySync();
                },
                {
                    root: viewport,
                    rootMargin: `${-(
                        scrollMarginRef.value + scrollPreviousItemPeekRef.value
                    )}px 0px 0px 0px`,
                    threshold: [0, 0.01, 0.5, 1],
                },
            );
        }

        messageElementsRef.value.forEach((element) => {
            visibilityObserverRef.value?.observe(element);
        });
        scheduleVisibilitySync();
    }

    function unobserveVisibility() {
        if (visibilityFrameRef.value !== null) {
            window.cancelAnimationFrame(visibilityFrameRef.value);
            visibilityFrameRef.value = null;
        }

        visibilityObserverRef.value?.disconnect();
        visibilityObserverRef.value = null;
        visibleMessageIdsRef.value.clear();
        visibilityStore.value.setSnapshot(EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE);
    }

    const registerMessage: MessageScrollerRegisterMessage = (
        messageId,
        element,
        removedElement,
    ) => {
        if (element) {
            messageElementsRef.value.set(messageId, element);
            visibilityObserverRef.value?.observe(element);
            scheduleVisibilitySync();

            if (pendingScrollToMessageRef.value?.messageId === messageId) {
                schedulePendingScrollToMessageFlush();
            }

            return;
        }

        if (removedElement && messageElementsRef.value.get(messageId) === removedElement) {
            messageElementsRef.value.delete(messageId);
            visibleMessageIdsRef.value.delete(messageId);
            visibilityObserverRef.value?.unobserve(removedElement);
            scheduleVisibilitySync();
        }
    };

    function userScrollIntent() {
        if (
            modeRef.value === "following-bottom" ||
            modeRef.value === "anchored-to-message" ||
            modeRef.value === "settling-jump"
        ) {
            streamingTurnRef.value = null;
            modeRef.value = "free-scrolling";
        }
    }

    function mirrorStateAttributes() {
        writeStateAttributes(stateStore.value.getSnapshot());
    }

    function setRootElement(element: HTMLDivElement | null) {
        rootRef.value = element;

        if (element) {
            mirrorStateAttributes();
        }
    }

    function setViewportElement(element: HTMLDivElement | null) {
        viewportRef.value = element;

        if (element) {
            mirrorStateAttributes();
        }
    }

    function setContentElement(element: HTMLDivElement | null) {
        contentRef.value = element;
    }

    function setSpacerElement(element: HTMLDivElement | null) {
        spacerRef.value = element;
    }

    function syncAfterScroll() {
        commitScrollState();
        scheduleVisibilitySync();
        capturePrependAnchor();
    }

    const context: MessageScrollerContextValue = {
        handleContentChange,
        handleResize,
        observeVisibility,
        preserveScrollOnPrependRef: preserveScrollOnPrependRef as unknown as { current: boolean },
        setPendingPrepend: (value: boolean) => {
            pendingPrependRef.value = value;
        },
        /** PLAN-0760：只读观测标志（测试与诊断用，不开放写）。 */
        getPendingPrepend: () => pendingPrependRef.value,
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
    };

    watch(
        [() => autoScroll, () => defaultScrollPosition],
        () => {
            applyDefaultScrollPosition();
        },
        { flush: "post" },
    );

    onUnmounted(() => {
        if (stateFrameRef.value !== null) {
            window.cancelAnimationFrame(stateFrameRef.value);
            stateFrameRef.value = null;
        }

        if (visibilityFrameRef.value !== null) {
            window.cancelAnimationFrame(visibilityFrameRef.value);
            visibilityFrameRef.value = null;
        }

        if (autoscrollingTimeoutRef.value !== null) {
            window.clearTimeout(autoscrollingTimeoutRef.value);
            autoscrollingTimeoutRef.value = null;
        }

        if (pendingScrollFrameRef.value !== null) {
            window.cancelAnimationFrame(pendingScrollFrameRef.value);
            pendingScrollFrameRef.value = null;
        }

        visibilityObserverRef.value?.disconnect();
        visibilityObserverRef.value = null;
    });

    return {
        context,
        registerMessage,
    };
}
