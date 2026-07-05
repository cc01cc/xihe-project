<script setup lang="ts">
import {
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import {
  USER_SCROLL_KEYS,
  type MessageScrollerViewportProps,
} from '@/lib/messageScrollerTypes'
import { useMessageScrollerContext } from '@/composables/messageScroller'

const props = withDefaults(defineProps<MessageScrollerViewportProps>(), {
  preserveScrollOnPrepend: true,
})

const emit = defineEmits<{
  scroll: [event: Event]
  wheel: [event: WheelEvent]
  touchMove: [event: TouchEvent]
  keyDown: [event: KeyboardEvent]
}>()

const {
  handleResize,
  preserveScrollOnPrependRef,
  setViewportElement,
  syncAfterScroll,
  userScrollIntent,
  viewportRef,
} = useMessageScrollerContext()

preserveScrollOnPrependRef.current = props.preserveScrollOnPrepend

const viewportEl = ref<HTMLDivElement | null>(null)

watch(viewportEl, (el) => {
  setViewportElement(el)
})

function handleScroll(event: Event) {
  syncAfterScroll()
  emit('scroll', event)
}

function handleWheel(event: WheelEvent) {
  userScrollIntent()
  emit('wheel', event)
}

function handleTouchMove(event: TouchEvent) {
  userScrollIntent()
  emit('touchMove', event)
}

function handleKeyDown(event: KeyboardEvent) {
  if (USER_SCROLL_KEYS.has(event.key)) {
    userScrollIntent()
  }

  emit('keyDown', event)
}

let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (viewportRef.current && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(viewportRef.current)
  }
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})
</script>

<template>
  <div
    ref="viewportEl"
    data-slot="message-scroller-viewport"
    data-testid="message-scroller-viewport"
    role="region"
    aria-label="Messages"
    tabindex="0"
    class="min-h-0 min-w-0 w-full flex-1 scroll-fade-b overflow-y-auto overscroll-contain contain-content"
    @scroll="handleScroll"
    @wheel="handleWheel"
    @touchmove="handleTouchMove"
    @keydown="handleKeyDown"
  >
    <slot />
  </div>
</template>
