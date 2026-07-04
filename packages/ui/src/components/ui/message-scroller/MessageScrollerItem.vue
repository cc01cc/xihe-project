<script setup lang="ts">
import { ref, watch } from 'vue'
import { useMessageScrollerItemContext } from '@/composables/messageScroller'

const props = defineProps<{
  messageId?: string
  scrollAnchor?: boolean
  class?: string
}>()

const registerMessage = useMessageScrollerItemContext()
const elementRef = ref<HTMLDivElement | null>(null)

watch(
  [() => props.messageId, () => elementRef.value],
  ([messageId, element], [, prevElement]) => {
    if (messageId) {
      registerMessage(messageId, element, prevElement)
    }
  },
  { immediate: true, flush: 'post' },
)
</script>

<template>
  <div
    ref="elementRef"
    data-slot="message-scroller-item"
    :data-message-id="props.messageId"
    :data-scroll-anchor="props.scrollAnchor ? 'true' : 'false'"
    :class="[
      'min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]',
      props.class,
    ]"
  >
    <slot />
  </div>
</template>
