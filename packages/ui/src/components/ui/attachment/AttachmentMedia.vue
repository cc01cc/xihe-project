<script setup lang="ts">
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const attachmentMediaVariants = cva(
  'relative flex aspect-square w-10 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-muted text-foreground group-data-[orientation=vertical]/attachment:w-full group-data-[size=sm]/attachment:w-8 group-data-[size=xs]/attachment:w-7 group-data-[size=xs]/attachment:rounded-xl group-data-[state=error]/attachment:bg-destructive/10 group-data-[state=error]/attachment:text-destructive group-data-[orientation=vertical]/attachment:*:data-[slot=spinner]:size-6! [&_svg]:pointer-events-none [&_svg:not([class*="size-"])]:size-4 group-data-[orientation=vertical]/attachment:[&_svg:not([class*="size-"])]:size-6 group-data-[size=xs]/attachment:[&_svg:not([class*="size-")]]:size-3.5',
  {
    variants: {
      variant: {
        icon: '',
        image:
          'opacity-60 group-data-[state=done]/attachment:opacity-100 group-data-[state=idle]/attachment:opacity-100 *:[img]:aspect-square *:[img]:w-full *:[img]:object-cover',
      },
    },
    defaultVariants: {
      variant: 'icon',
    },
  },
)

const props = withDefaults(
  defineProps<{
    class?: string
    variant?: VariantProps<typeof attachmentMediaVariants>['variant']
  }>(),
  {
    variant: 'icon',
  },
)
</script>

<template>
  <div
    data-slot="attachment-media"
    :data-variant="props.variant"
    :class="cn(attachmentMediaVariants({ variant: props.variant }), props.class)"
  >
    <slot />
  </div>
</template>
