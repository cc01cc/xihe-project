<script setup lang="ts">
import { cn } from '@/lib/utils'

const props = defineProps<{
  class?: string
}>()
</script>

<template>
  <div
    data-slot="message-content"
    :class="cn(
      'flex w-full min-w-0 flex-col gap-2.5 break-words group-data-[align=end]/message:*:data-slot:self-end',
      props.class,
    )"
  >
    <slot />
  </div>
</template>
