<script setup lang="ts">
import {
  onMounted,
  onUnmounted,
  ref,
  watch,
} from 'vue'
import { useMessageScrollerContext } from '@/composables/messageScroller'

const props = defineProps<{
  class?: string
  spacerClassName?: string
}>()

const { handleContentChange, handleResize, setContentElement, setSpacerElement } =
  useMessageScrollerContext()

const contentEl = ref<HTMLDivElement | null>(null)
const spacerEl = ref<HTMLDivElement | null>(null)

watch(contentEl, (el) => {
  setContentElement(el)
})

watch(spacerEl, (el) => {
  setSpacerElement(el)
})

let mutationObserver: MutationObserver | null = null
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  if (contentEl.value) {
    handleContentChange()

    if (typeof MutationObserver !== 'undefined') {
      mutationObserver = new MutationObserver(handleContentChange)
      mutationObserver.observe(contentEl.value, { childList: true })
    }

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(handleResize)
      resizeObserver.observe(contentEl.value)
    }
  }
})

onUnmounted(() => {
  mutationObserver?.disconnect()
  resizeObserver?.disconnect()
})
</script>

<template>
  <div
    ref="contentEl"
    data-slot="message-scroller-content"
    role="log"
    aria-relevant="additions"
    :class="['flex h-max min-h-full flex-col gap-8', props.class]"
  >
    <slot />
    <div
      ref="spacerEl"
      aria-hidden="true"
      data-message-scroller-spacer=""
      hidden
      :class="props.spacerClassName"
    />
  </div>
</template>
