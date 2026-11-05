import {
    AUTOSCROLLING_CLEAR_DELAY,
    SCROLL_POSITION_EPSILON,
    type MessageScrollerScrollOptions,
} from "@/lib/messageScrollerTypes";
import {
    getElementScrollTop,
    getElementViewportTop,
    getMaxScrollTop,
    getTailSpacerHeight,
} from "@/lib/messageScrollerGeometry";
import type { UseMessageScrollerRefsReturn } from "./messageScrollerRefs";

export interface UseMessageScrollerCommandsOptions {
    refs: UseMessageScrollerRefsReturn;
    commitScrollState: () => void;
    scheduleStateCommit: () => void;
    scheduleVisibilitySync: () => void;
}

export function useMessageScrollerCommands({
    refs,
    commitScrollState,
    scheduleStateCommit,
    scheduleVisibilitySync,
}: UseMessageScrollerCommandsOptions) {
    const {
        streamingTurnRef,
        autoScrollRef,
        autoscrollingRef,
        autoscrollingTimeoutRef,
        contentRef,
        defaultScrollPositionAppliedRef,
        itemCountRef,
        messageElementsRef,
        modeRef,
        pendingScrollToMessageRef,
        prependRestoreRef,
        scrollMarginRef,
        scrollPreviousItemPeekRef,
        spacerGapRef,
        spacerHeightRef,
        spacerRef,
        viewportRef,
    } = refs;

    function setAutoScrolling(autoscrolling: boolean) {
        if (autoscrollingTimeoutRef.value !== null) {
            window.clearTimeout(autoscrollingTimeoutRef.value);
            autoscrollingTimeoutRef.value = null;
        }

        if (autoscrollingRef.value !== autoscrolling) {
            autoscrollingRef.value = autoscrolling;
            commitScrollState();
        }

        if (autoscrolling) {
            autoscrollingTimeoutRef.value = window.setTimeout(() => {
                autoscrollingTimeoutRef.value = null;
                autoscrollingRef.value = false;
                commitScrollState();
            }, AUTOSCROLLING_CLEAR_DELAY);
        }
    }

    function setTailSpacerHeight(height: number) {
        const spacer = spacerRef.value;

        if (!spacer) {
            return;
        }

        const nextHeight = Math.max(0, Math.ceil(height));

        if (spacerHeightRef.value === nextHeight) {
            return;
        }

        spacerHeightRef.value = nextHeight;
        spacer.hidden = nextHeight === 0;
        spacer.style.height = `${nextHeight}px`;
        spacer.style.marginTop = nextHeight > 0 ? `${-spacerGapRef.value}px` : "";
    }

    function scrollToPosition(
        scrollTop: number,
        {
            behavior = "auto",
            autoscrolling = false,
        }: {
            behavior?: ScrollBehavior;
            autoscrolling?: boolean;
        } = {},
    ) {
        const viewport = viewportRef.value;

        if (!viewport) {
            return;
        }

        const nextScrollTop = Math.max(0, scrollTop);

        if (Math.abs(viewport.scrollTop - nextScrollTop) <= SCROLL_POSITION_EPSILON) {
            viewport.scrollTop = nextScrollTop;
            commitScrollState();
            return;
        }

        if (autoscrolling) {
            setAutoScrolling(true);
        }

        viewport.scrollTo({
            top: nextScrollTop,
            behavior,
        });
        scheduleStateCommit();
    }

    function scrollToStart({ behavior = "auto" }: MessageScrollerScrollOptions = {}) {
        if (!viewportRef.value) {
            return false;
        }

        setTailSpacerHeight(0);
        streamingTurnRef.value = null;
        modeRef.value = "free-scrolling";
        scrollToPosition(0, { behavior });
        scheduleVisibilitySync();

        return true;
    }

    /**
     * 滚到底部。
     *
     * **不变式（BL-340）：`mode` 是"观测结果"，不是命令的副作用。**
     * 只有**用户显式动作**（如"回到最新"按钮，`reason: "user"`）才允许把模式声明为
     * `following-bottom`；跟随/贴底语义由"当前是否真的在底部"的几何判据派生。
     * 背景：旧实现无条件 `modeRef = following-bottom`，于是任何一次贴底都会让下一次
     * 窗口换页再次命中"贴底跟随例外"⇒ 换页 ↔ 贴底 闭环自激（实测 8×500px 上滚里 40 次
     * 应用侧 `scrollTop` 写入全部来自本函数）。
     */
    function scrollToEnd({
        behavior = "auto",
        reason = "follow",
    }: MessageScrollerScrollOptions & { reason?: "user" | "follow" } = {}) {
        const viewport = viewportRef.value;

        if (!viewport) {
            return false;
        }

        setTailSpacerHeight(0);
        streamingTurnRef.value = null;
        if (reason === "user") {
            modeRef.value = autoScrollRef.value ? "following-bottom" : "free-scrolling";
        }
        scrollToPosition(getMaxScrollTop(viewport), {
            autoscrolling: true,
            behavior,
        });
        scheduleVisibilitySync();

        return true;
    }

    function scrollToElement(
        element: HTMLElement,
        {
            align = "start",
            behavior = "auto",
            scrollMargin = scrollMarginRef.value,
        }: MessageScrollerScrollOptions = {},
        { keepPreviousPeek = false }: { keepPreviousPeek?: boolean } = {},
    ) {
        const content = contentRef.value,
            viewport = viewportRef.value;

        if (!content || !viewport || !content.contains(element)) {
            return false;
        }

        const scrollTop = getElementScrollTop({
            align,
            element,
            scrollMargin: keepPreviousPeek
                ? scrollMargin + scrollPreviousItemPeekRef.value
                : scrollMargin,
            spacer: spacerRef.value,
            viewport,
        });

        const nextSpacerHeight = getTailSpacerHeight({
            content,
            scrollTop,
            spacer: spacerRef.value,
            viewport,
        });

        setTailSpacerHeight(nextSpacerHeight);
        prependRestoreRef.value = {
            element,
            viewportTop: getElementViewportTop(element, viewport),
        };

        modeRef.value = keepPreviousPeek ? "anchored-to-message" : "settling-jump";
        streamingTurnRef.value = keepPreviousPeek ? element : null;

        scrollToPosition(scrollTop, { behavior });
        scheduleVisibilitySync();

        return true;
    }

    function reanchorToAnchoredMessage() {
        const element = streamingTurnRef.value;

        if (!element || !element.isConnected || modeRef.value !== "anchored-to-message") {
            return false;
        }

        return scrollToElement(element, { align: "start" }, { keepPreviousPeek: true });
    }

    function scrollToMessage(messageId: string, options?: MessageScrollerScrollOptions) {
        const element = messageElementsRef.value.get(messageId);

        if (!element) {
            if (itemCountRef.value === 0) {
                pendingScrollToMessageRef.value = { messageId, options };
                defaultScrollPositionAppliedRef.value = true;

                return true;
            }

            return false;
        }

        defaultScrollPositionAppliedRef.value = true;

        if (scrollToElement(element, options)) {
            pendingScrollToMessageRef.value = null;
            return true;
        }

        pendingScrollToMessageRef.value = { messageId, options };

        return true;
    }

    function flushPendingScrollToMessage() {
        const pending = pendingScrollToMessageRef.value;

        if (!pending) {
            return false;
        }

        const element = messageElementsRef.value.get(pending.messageId);

        if (!element) {
            return false;
        }

        const handled = scrollToElement(element, pending.options);

        if (!handled) {
            return false;
        }

        pendingScrollToMessageRef.value = null;
        defaultScrollPositionAppliedRef.value = true;

        return true;
    }

    return {
        flushPendingScrollToMessage,
        reanchorToAnchoredMessage,
        scrollToElement,
        scrollToEnd,
        scrollToMessage,
        scrollToStart,
    };
}
