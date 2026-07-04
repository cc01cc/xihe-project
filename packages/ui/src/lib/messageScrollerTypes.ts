// 默认滚动边缘阈值。子像素容差，避免不同引擎对 scrollTop 取整导致边缘检测抖动。
export const DEFAULT_SCROLL_EDGE_THRESHOLD = 8

// 默认前一项窥视高度。新锚定行上方保留的前一条消息的像素数。
export const DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK = 64

// 默认 scrollToMessage 滚动边距。
export const DEFAULT_SCROLL_MARGIN = 0

// 两个 scrollTop 差值小于此值视为相等，吸收缩放和 HiDPI 取整漂移。
export const SCROLL_POSITION_EPSILON = 0.5

// 程序化平滑滚动期间 data-autoscrolling 保持的毫秒数。
export const AUTOSCROLLING_CLEAR_DELAY = 180

// 视为用户滚动意图的视口按键。
export const USER_SCROLL_KEYS = new Set([
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  ' ',
])

export type MessageScrollerMode =
  | 'following-bottom'
  | 'free-scrolling'
  | 'anchored-to-message'
  | 'settling-jump'

export type MessageScrollerDefaultScrollPosition = 'start' | 'end' | 'last-anchor'
export type MessageScrollerButtonDirection = 'start' | 'end'
export type MessageScrollerScrollAlign = 'start' | 'center' | 'end' | 'nearest'

export interface MessageScrollerScrollOptions {
  align?: MessageScrollerScrollAlign
  behavior?: ScrollBehavior
  scrollMargin?: number
}

export interface MessageScrollerScrollable {
  start: boolean
  end: boolean
}

export interface MessageScrollerVisibilityState {
  currentAnchorId: string | null
  visibleMessageIds: string[]
}

export interface MessageScrollerProviderProps {
  children?: unknown
  autoScroll?: boolean
  defaultScrollPosition?: MessageScrollerDefaultScrollPosition
  scrollEdgeThreshold?: number
  scrollPreviousItemPeek?: number
  scrollMargin?: number
}

export interface MessageScrollerViewportProps {
  preserveScrollOnPrepend?: boolean
}

export interface MessageScrollerContentProps {
  spacerClassName?: string
}

export interface MessageScrollerItemProps {
  messageId?: string
  scrollAnchor?: boolean
}

export interface MessageScrollerButtonRenderState {
  active: boolean
  direction: MessageScrollerButtonDirection
}

export interface MessageScrollerStore<T> {
  getSnapshot: () => T
  setSnapshot: (nextSnapshot: T) => void
  subscribe: (listener: () => void) => () => void
}

export interface MessageScrollerVisibilityStore {
  getSnapshot: () => MessageScrollerVisibilityState
  hasListeners: () => boolean
  setSnapshot: (nextSnapshot: MessageScrollerVisibilityState) => void
  subscribe: (
    listener: () => void,
    onFirstSubscribe?: () => void,
    onLastUnsubscribe?: () => void
  ) => () => void
}

export type MessageScrollerRegisterMessage = (
  messageId: string,
  element: HTMLElement | null,
  removedElement?: HTMLElement | null
) => void

export interface MessageScrollerContextValue {
  handleContentChange: () => void
  handleResize: () => void
  observeVisibility: () => void
  preserveScrollOnPrependRef: { current: boolean }
  scrollToEnd: (options?: MessageScrollerScrollOptions) => boolean
  scrollToMessage: (messageId: string, options?: MessageScrollerScrollOptions) => boolean
  scrollToStart: (options?: MessageScrollerScrollOptions) => boolean
  setContentElement: (element: HTMLDivElement | null) => void
  setRootElement: (element: HTMLDivElement | null) => void
  setSpacerElement: (element: HTMLDivElement | null) => void
  setViewportElement: (element: HTMLDivElement | null) => void
  stateStore: MessageScrollerStore<MessageScrollerScrollable>
  syncAfterScroll: () => void
  unobserveVisibility: () => void
  userScrollIntent: () => void
  viewportRef: { current: HTMLDivElement | null }
  visibilityStore: MessageScrollerVisibilityStore
}

export const EMPTY_MESSAGE_SCROLLER_SCROLLABLE: MessageScrollerScrollable = {
  start: false,
  end: false,
}

export const EMPTY_VISIBLE_MESSAGE_IDS: string[] = []

export const EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE: MessageScrollerVisibilityState = {
  currentAnchorId: null,
  visibleMessageIds: EMPTY_VISIBLE_MESSAGE_IDS,
}
