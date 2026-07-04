<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: string
}>()
</script>

<template>
  <span
    data-slot="attachment-description"
    :class="cn(
      'mt-0.5 block min-w-0 truncate text-xs text-muted-foreground group-data-[state=error]/attachment:text-destructive/80 max-w-full',
      props.class,
    )"
  >
    <slot />
  </span>
</template>
