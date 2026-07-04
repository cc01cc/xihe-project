<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: string
}>()
</script>

<template>
  <div
    data-slot="message-footer"
    :class="cn(
      'flex max-w-full min-w-0 items-center px-3.5 text-xs font-medium text-muted-foreground group-data-[align=end]/message:justify-end',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
