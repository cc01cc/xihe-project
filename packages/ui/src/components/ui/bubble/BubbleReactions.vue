<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const bubbleReactionsVariants = cva(
  'absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-sm ring-3 ring-card has-[button]:p-0',
  {
    variants: {
      side: {
        top: 'top-0 -translate-y-3/4',
        bottom: 'bottom-0 translate-y-3/4',
      },
      align: {
        start: 'left-3',
        end: 'right-3',
      },
    },
    defaultVariants: {
      side: 'bottom',
      align: 'end',
    },
  },
)

type BubbleReactionsVariants = VariantProps<typeof bubbleReactionsVariants>

const props = withDefaults(
  defineProps<{
    class?: string
    side?: BubbleReactionsVariants['side']
    align?: BubbleReactionsVariants['align']
  }>(),
  {
    side: 'bottom',
    align: 'end',
  },
)
</script>

<template>
  <div
    data-slot="bubble-reactions"
    :data-align="props.align"
    :data-side="props.side"
    :class="cn(bubbleReactionsVariants({ side: props.side, align: props.align }), props.class)"
  >
    <slot />
  </div>
</template>
