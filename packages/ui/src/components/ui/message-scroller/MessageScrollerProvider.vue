<script setup lang="ts">
import { provide } from 'vue'
import {
  MessageScrollerContextKey,
  MessageScrollerItemContextKey,
  useMessageScrollerController,
} from '@/composables/messageScroller'
import type { MessageScrollerProviderProps } from '@/lib/messageScrollerTypes'

const props = withDefaults(defineProps<MessageScrollerProviderProps>(), {
  autoScroll: false,
  defaultScrollPosition: 'end',
})

const { context, registerMessage } = useMessageScrollerController({
  autoScroll: props.autoScroll,
  defaultScrollPosition: props.defaultScrollPosition,
  scrollEdgeThreshold: props.scrollEdgeThreshold,
  scrollPreviousItemPeek: props.scrollPreviousItemPeek,
  scrollMargin: props.scrollMargin,
})

provide(MessageScrollerContextKey, context)
provide(MessageScrollerItemContextKey, registerMessage)
</script>

<template>
  <slot />
</template>
