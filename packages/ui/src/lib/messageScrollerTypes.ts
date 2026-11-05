// 默认滚动边缘阈值。子像素容差，避免不同引擎对 scrollTop 取整导致边缘检测抖动。
export const DEFAULT_SCROLL_EDGE_THRESHOLD = 8;

// 默认前一项窥视高度。新锚定行上方保留的前一条消息的像素数。
export const DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK = 64;

// 默认 scrollToMessage 滚动边距。
export const DEFAULT_SCROLL_MARGIN = 0;

// 两个 scrollTop 差值小于此值视为相等，吸收缩放和 HiDPI 取整漂移。
export const SCROLL_POSITION_EPSILON = 0.5;

// 程序化平滑滚动期间 data-autoscrolling 保持的毫秒数。
export const AUTOSCROLLING_CLEAR_DELAY = 180;

// 视为用户滚动意图的视口按键。
export const USER_SCROLL_KEYS = new Set([
    "ArrowDown",
    "ArrowUp",
    "End",
    "Home",
    "PageDown",
    "PageUp",
    " ",
]);

export type MessageScrollerMode =
    | "following-bottom"
    | "free-scrolling"
    | "anchored-to-message"
    | "settling-jump";

export type MessageScrollerDefaultScrollPosition = "start" | "end" | "last-anchor";
export type MessageScrollerButtonDirection = "start" | "end";
export type MessageScrollerScrollAlign = "start" | "center" | "end" | "nearest";

export interface MessageScrollerScrollOptions {
    align?: MessageScrollerScrollAlign;
    behavior?: ScrollBehavior;
    scrollMargin?: number;
    /**
     * BL-340：动作意图。只有 `"user"`（用户显式动作，如「回到最新」按钮）允许改写
     * `modeRef`；跟随/贴底语义由几何判据派生，不由命令的副作用维持。
     * 目前仅 `scrollToEnd()` 消费该字段。
     */
    reason?: "user" | "follow";
}

export interface MessageScrollerScrollable {
    start: boolean;
    end: boolean;
}

export interface MessageScrollerVisibilityState {
    currentAnchorId: string | null;
    visibleMessageIds: string[];
}

export interface MessageScrollerProviderProps {
    children?: unknown;
    autoScroll?: boolean;
    defaultScrollPosition?: MessageScrollerDefaultScrollPosition;
    scrollEdgeThreshold?: number;
    scrollPreviousItemPeek?: number;
    scrollMargin?: number;
    /**
     * BL-316 第二步：当内容 DOM 是**投影**（虚拟窗口只渲染窗口内的行）时，声明底层完整条目数
     * （`MessageList` 传 `rows.length`）。不传 = 不是投影，行为与改造前逐字一致。
     *
     * 用途：区分「窗口换页」与「新消息到达」。窗口换页时 DOM 子节点的首行与末行都会变，
     * 但**底层条目数不变**；据此可以判定这次变化不携带新数据，从而跳过后面的
     * `getNewScrollAnchor` / `scrollToElement`（那条路径会把正在上滚的用户拽回底部）。
     * 这是**显式声明的事实**（数据层行数），不是从 DOM 猜测 itemCount 差值。
     */
    sourceItemCount?: number;
}

export interface MessageScrollerViewportProps {
    preserveScrollOnPrepend?: boolean;
}

export interface MessageScrollerContentProps {
    spacerClassName?: string;
}

export interface MessageScrollerItemProps {
    messageId?: string;
    scrollAnchor?: boolean;
}

export interface MessageScrollerButtonRenderState {
    active: boolean;
    direction: MessageScrollerButtonDirection;
}

export interface MessageScrollerStore<T> {
    getSnapshot: () => T;
    setSnapshot: (nextSnapshot: T) => void;
    subscribe: (listener: () => void) => () => void;
}

export interface MessageScrollerVisibilityStore {
    getSnapshot: () => MessageScrollerVisibilityState;
    hasListeners: () => boolean;
    setSnapshot: (nextSnapshot: MessageScrollerVisibilityState) => void;
    subscribe: (
        listener: () => void,
        onFirstSubscribe?: () => void,
        onLastUnsubscribe?: () => void,
    ) => () => void;
}

export type MessageScrollerRegisterMessage = (
    messageId: string,
    element: HTMLElement | null,
    removedElement?: HTMLElement | null,
) => void;

export interface MessageScrollerContextValue {
    handleContentChange: () => void;
    handleResize: () => void;
    observeVisibility: () => void;
    preserveScrollOnPrependRef: { current: boolean };
    scrollToEnd: (options?: MessageScrollerScrollOptions) => boolean;
    scrollToMessage: (messageId: string, options?: MessageScrollerScrollOptions) => boolean;
    scrollToStart: (options?: MessageScrollerScrollOptions) => boolean;
    setContentElement: (element: HTMLDivElement | null) => void;
    setRootElement: (element: HTMLDivElement | null) => void;
    setSpacerElement: (element: HTMLDivElement | null) => void;
    setViewportElement: (element: HTMLDivElement | null) => void;
    stateStore: MessageScrollerStore<MessageScrollerScrollable>;
    syncAfterScroll: () => void;
    unobserveVisibility: () => void;
    userScrollIntent: () => void;
    viewportRef: { current: HTMLDivElement | null };
    visibilityStore: MessageScrollerVisibilityStore;
}

export const EMPTY_MESSAGE_SCROLLER_SCROLLABLE: MessageScrollerScrollable = {
    start: false,
    end: false,
};

export const EMPTY_VISIBLE_MESSAGE_IDS: string[] = [];

export const EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE: MessageScrollerVisibilityState = {
    currentAnchorId: null,
    visibleMessageIds: EMPTY_VISIBLE_MESSAGE_IDS,
};
