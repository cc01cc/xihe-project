import { inject, provide, ref, shallowRef, triggerRef, watch } from 'vue'
import type {
  MessageScrollerContextValue,
  MessageScrollerRegisterMessage,
  MessageScrollerScrollable,
  MessageScrollerVisibilityState,
} from '@/lib/messageScrollerTypes'

export const MessageScrollerContextKey = Symbol('MessageScrollerContext')
export const MessageScrollerItemContextKey = Symbol('MessageScrollerItemContext')

export function provideMessageScrollerContext(context: MessageScrollerContextValue) {
  provide(MessageScrollerContextKey, context)
}

export function useMessageScrollerContext(): MessageScrollerContextValue {
  const context = inject<MessageScrollerContextValue>(MessageScrollerContextKey)

  if (!context) {
    throw new Error('useMessageScroller must be used within a MessageScroller.')
  }

  return context
}

export function provideMessageScrollerItemContext(
  registerMessage: MessageScrollerRegisterMessage,
) {
  provide(MessageScrollerItemContextKey, registerMessage)
}

export function useMessageScrollerItemContext(): MessageScrollerRegisterMessage {
  const context = inject<MessageScrollerRegisterMessage>(MessageScrollerItemContextKey)

  if (!context) {
    throw new Error('MessageScrollerItem must be used within a MessageScroller.')
  }

  return context
}

export function useMessageScroller() {
  const { scrollToEnd, scrollToMessage, scrollToStart } = useMessageScrollerContext()

  return {
    scrollToEnd,
    scrollToMessage,
    scrollToStart,
  }
}

export function useMessageScrollerScrollable() {
  const { stateStore } = useMessageScrollerContext()
  const snapshot = shallowRef<MessageScrollerScrollable>(stateStore.getSnapshot())

  stateStore.subscribe(() => {
    snapshot.value = stateStore.getSnapshot()
    triggerRef(snapshot)
  })

  watch(() => stateStore.getSnapshot(), () => {
    snapshot.value = stateStore.getSnapshot()
  })

  return snapshot
}

export function useMessageScrollerVisibility() {
  const { observeVisibility, unobserveVisibility, visibilityStore } = useMessageScrollerContext()
  const snapshot = ref<MessageScrollerVisibilityState>(visibilityStore.getSnapshot())

  const subscribe = (listener: () => void) =>
    visibilityStore.subscribe(
      listener,
      observeVisibility,
      unobserveVisibility,
    )

  subscribe(() => {
    snapshot.value = visibilityStore.getSnapshot()
  })

  observeVisibility()

  return snapshot
}
