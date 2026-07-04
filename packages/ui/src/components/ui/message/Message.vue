<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  class?: string
  align?: 'start' | 'end'
}>(), {
  align: 'start',
})
</script>

<template>
  <div
    data-slot="message"
    :data-align="props.align"
    :class="cn(
      'group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
