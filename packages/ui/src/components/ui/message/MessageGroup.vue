<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: string
}>()
</script>

<template>
  <div
    data-slot="message-group"
    :class="cn('flex min-w-0 flex-col gap-2', props.class)"
  >
    <slot />
  </div>
</template>
