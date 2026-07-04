<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const attachmentVariants = cva(
  'group/attachment relative flex w-fit max-w-full min-w-0 shrink-0 flex-wrap rounded-3xl border bg-card text-card-foreground transition-colors focus-within:ring-1 focus-within:ring-ring/30 has-[>a,button]:hover:bg-muted/50 data-[state=error]:border-destructive/30 data-[state=idle]:border-dashed',
  {
    variants: {
      size: {
        default:
          'gap-2 text-sm has-data-[slot=attachment-content]:px-2.5 has-data-[slot=attachment-content]:py-2 has-data-[slot=attachment-media]:p-2',
        sm: 'gap-2.5 text-xs has-data-[slot=attachment-content]:px-2 has-data-[slot=attachment-content]:py-1.5 has-data-[slot=attachment-media]:p-1.5',
        xs: 'gap-1.5 rounded-2xl text-xs has-data-[slot=attachment-content]:px-1.5 has-data-[slot=attachment-content]:py-1 has-data-[slot=attachment-media]:p-1',
      },
      orientation: {
        horizontal: 'min-w-40 items-center',
        vertical: 'w-24 flex-col has-data-[slot=attachment-content]:w-30',
      },
    },
  },
)

const props = withDefaults(
  defineProps<{
    class?: string
    state?: 'idle' | 'uploading' | 'processing' | 'error' | 'done'
    size?: VariantProps<typeof attachmentVariants>['size']
    orientation?: VariantProps<typeof attachmentVariants>['orientation']
  }>(),
  {
    state: 'done',
    size: 'default',
    orientation: 'horizontal',
  },
)
</script>

<template>
  <div
    data-slot="attachment"
    :data-state="props.state"
    :data-size="props.size"
    :data-orientation="props.orientation"
    :class="cn(attachmentVariants({ size: props.size, orientation: props.orientation }), props.class)"
  >
    <slot />
  </div>
</template>
