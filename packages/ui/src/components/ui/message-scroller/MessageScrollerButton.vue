<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDown } from '@lucide/vue'
import { useMessageScrollerContext, useMessageScrollerScrollable } from '@/composables/messageScroller'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const props = withDefaults(defineProps<{
  direction?: 'start' | 'end'
  behavior?: ScrollBehavior
  class?: string
  variant?: 'secondary' | 'default' | 'outline' | 'ghost'
  size?: 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm' | 'icon-xs'
}>(), {
  direction: 'end',
  behavior: 'smooth',
  variant: 'secondary',
  size: 'icon-sm',
})

const { scrollToEnd, scrollToStart } = useMessageScrollerContext()
const scrollable = useMessageScrollerScrollable()

const isActive = computed(() => {
  return props.direction === 'start' ? scrollable.value.start : scrollable.value.end
})

function handleClick(event: MouseEvent) {
  if (!isActive.value) return

  const target = event.currentTarget as HTMLButtonElement
  target.blur()

  if (props.direction === 'start') {
    scrollToStart({ behavior: props.behavior })
  } else {
    scrollToEnd({ behavior: props.behavior })
  }
}
</script>

<template>
  <Button
    data-slot="message-scroller-button"
    data-testid="message-scroller-button"
    :data-direction="direction"
    :data-variant="variant"
    :data-size="size"
    :variant="variant"
    :size="size"
    :class="cn(
      'absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180',
      props.class,
    )"
    :data-active="isActive ? 'true' : 'false'"
    :inert="!isActive"
    :tabindex="isActive ? 0 : -1"
    @click="handleClick"
  >
    <ArrowDown class="size-4" />
    <span class="sr-only">
      {{ direction === 'end' ? 'Scroll to end' : 'Scroll to start' }}
    </span>
  </Button>
</template>
