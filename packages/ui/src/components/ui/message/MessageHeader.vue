<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: string
}>()
</script>

<template>
  <div
    data-slot="message-header"
    :class="cn(
      'flex max-w-full min-w-0 items-center px-3.5 text-xs font-medium text-muted-foreground',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
