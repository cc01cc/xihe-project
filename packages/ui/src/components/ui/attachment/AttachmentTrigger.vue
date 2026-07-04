<script setup lang="ts">
import { cn } from '@/lib/utils'
import { Primitive } from 'reka-ui'

const props = withDefaults(defineProps<{
  class?: string
  asChild?: boolean
  type?: 'button' | 'submit' | 'reset'
}>(), {
  asChild: false,
  type: 'button',
})
</script>

<template>
  <Primitive.button
    data-slot="attachment-trigger"
    :as-child="props.asChild"
    :type="props.type"
    :class="cn('absolute inset-0 z-10 outline-none', props.class)"
  >
    <slot />
  </Primitive.button>
</template>
