<script setup lang="ts">
import { ContextMenuItem, type ContextMenuItemProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { cn } from "@/lib/utils"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<ContextMenuItemProps & {
  class?: HTMLAttributes["class"]
  inset?: boolean
  variant?: "default" | "destructive"
}>()
const emits = defineEmits<{ select: [event: Event] }>()

const delegatedProps = reactiveOmit(props, "class", "inset", "variant")
</script>

<template>
  <ContextMenuItem
    data-slot="context-menu-item"
    :data-inset="inset"
    :data-variant="variant"
    v-bind="{ ...$attrs, ...delegatedProps }"
    @select="(event) => emits('select', event)"
    :class="cn(`focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:text-destructive [&_svg:not([class*='size-'])]:size-4 relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0`, props.class)"
  >
    <slot />
  </ContextMenuItem>
</template>
