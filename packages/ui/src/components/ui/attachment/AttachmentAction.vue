<script setup lang="ts">
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  class?: string
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive'
  size?: 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm' | 'icon-xs'
}>()
</script>

<template>
  <Button
    data-slot="attachment-action"
    :variant="props.variant ?? 'ghost'"
    :size="props.size ?? 'icon-xs'"
    :class="cn(props.class)"
  >
    <slot />
  </Button>
</template>
