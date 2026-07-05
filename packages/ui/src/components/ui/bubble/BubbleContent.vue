<script setup lang="ts">
import { cn } from '@/lib/utils'
import { Primitive } from 'reka-ui'

const props = withDefaults(defineProps<{
  class?: string
  asChild?: boolean
}>(), {
  asChild: false,
})
</script>

<template>
  <Primitive
    as="div"
    data-slot="bubble-content"
    :as-child="props.asChild"
    :class="cn(
      'w-fit max-w-full min-w-0 overflow-hidden rounded-3xl border border-transparent px-3.5 py-2.5 text-sm leading-relaxed break-words group-data-[align=end]/bubble:self-end',
      props.class,
    )"
  >
    <slot />
  </Primitive>
</template>
