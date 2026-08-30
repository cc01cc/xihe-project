<script setup lang="ts">
import { computed, type Component } from 'vue'

export interface ToolbarAction {
  key: string
  position: 'left' | 'right'
  component: Component | string
  props?: Record<string, unknown>
  icon?: Component
  visible?: boolean | (() => boolean)
}

const props = defineProps<{
  actions: ToolbarAction[]
}>()

const leftActions = computed(() =>
  props.actions.filter((a) => a.position === 'left' && isVisible(a)),
)
const rightActions = computed(() =>
  props.actions.filter((a) => a.position === 'right' && isVisible(a)),
)

function isVisible(action: ToolbarAction): boolean {
  if (typeof action.visible === 'function') return action.visible()
  return action.visible !== false
}
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-1">
    <template
      v-for="action in leftActions"
      :key="action.key"
    >
      <component
        :is="action.component"
        v-bind="action.props"
      >
        <component
          :is="action.icon"
          v-if="action.icon"
          class="size-3.5"
        />
      </component>
    </template>

    <div class="min-w-2 flex-1" />

    <template
      v-for="action in rightActions"
      :key="action.key"
    >
      <component
        :is="action.component"
        v-bind="action.props"
      >
        <component
          :is="action.icon"
          v-if="action.icon"
          class="size-3.5"
        />
      </component>
    </template>
  </div>
</template>
