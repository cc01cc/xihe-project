import {
  EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE,
  type MessageScrollerScrollable,
  type MessageScrollerStore,
  type MessageScrollerVisibilityState,
  type MessageScrollerVisibilityStore,
} from '@/lib/messageScrollerTypes'

export function createExternalStore<T>(
  initialSnapshot: T,
  isEqual: (a: T, b: T) => boolean,
): {
  getSnapshot: () => T
  hasListeners: () => boolean
  setSnapshot: (nextSnapshot: T) => void
  subscribe: (
    listener: () => void,
    onFirstSubscribe?: () => void,
    onLastUnsubscribe?: () => void,
  ) => () => void
} {
  let snapshot = initialSnapshot
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    hasListeners: () => listeners.size > 0,
    setSnapshot: (nextSnapshot: T) => {
      if (isEqual(snapshot, nextSnapshot)) {
        return
      }

      snapshot = nextSnapshot
      listeners.forEach((listener) => listener())
    },
    subscribe: (
      listener: () => void,
      onFirstSubscribe?: () => void,
      onLastUnsubscribe?: () => void,
    ) => {
      const wasEmpty = listeners.size === 0

      listeners.add(listener)

      if (wasEmpty) {
        onFirstSubscribe?.()
      }

      return () => {
        listeners.delete(listener)

        if (listeners.size === 0) {
          onLastUnsubscribe?.()
        }
      }
    },
  }
}

export function createMessageScrollerStore<T>(
  initialSnapshot: T,
  isEqual: (a: T, b: T) => boolean,
): MessageScrollerStore<T> {
  return createExternalStore(initialSnapshot, isEqual)
}

export function createMessageScrollerVisibilityStore(): MessageScrollerVisibilityStore {
  return createExternalStore(
    EMPTY_MESSAGE_SCROLLER_VISIBILITY_STATE,
    areVisibilityStatesEqual,
  )
}

export function areScrollStatesEqual(
  current: MessageScrollerScrollable,
  next: MessageScrollerScrollable,
) {
  return current.start === next.start && current.end === next.end
}

export function areVisibilityStatesEqual(
  current: MessageScrollerVisibilityState,
  next: MessageScrollerVisibilityState,
) {
  if (current.currentAnchorId !== next.currentAnchorId) {
    return false
  }

  if (current.visibleMessageIds.length !== next.visibleMessageIds.length) {
    return false
  }

  return current.visibleMessageIds.every(
    (messageId, index) => messageId === next.visibleMessageIds[index],
  )
}
