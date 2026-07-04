
<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: string
}>()
</script>

<template>
  <span
    data-slot="marker-icon"
    aria-hidden="true"
    :class="cn('size-4 shrink-0 [&_svg:not([class*=\'size-\'])]:size-4', props.class)"
  >
    <slot />
  </span>
</template>
