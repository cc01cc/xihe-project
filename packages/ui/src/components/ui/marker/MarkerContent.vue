<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: string
}>()
</script>

<template>
  <span
    data-slot="marker-content"
    :class="cn(
      'min-w-0 break-words group-data-[variant=separator]/marker:flex-none group-data-[variant=separator]/marker:text-center',
      props.class,
    )"
  >
    <slot />
  </span>
</template>
