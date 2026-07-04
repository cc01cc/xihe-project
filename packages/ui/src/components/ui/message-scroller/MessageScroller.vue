<script setup lang="ts">
import { ref, watch } from 'vue'
import { useMessageScrollerContext } from '@/composables/messageScroller'

const props = defineProps<{
  class?: string
}>()

const { setRootElement } = useMessageScrollerContext()
const elementRef = ref<HTMLDivElement | null>(null)

watch(elementRef, (element) => {
  setRootElement(element)
}, { immediate: true })
</script>

<template>
  <div
    ref="elementRef"
    data-slot="message-scroller"
    :class="[
      'group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden',
      props.class,
    ]"
  >
    <slot />
  </div>
</template>
