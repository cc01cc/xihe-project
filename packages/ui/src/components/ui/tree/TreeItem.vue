<script setup lang="ts" generic="T extends Record<string, any>">
import { TreeItem, type TreeItemProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { computed } from "vue"
import { cn } from "@/lib/utils"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<TreeItemProps<T> & { class?: HTMLAttributes["class"] }>()

const delegatedProps = computed(() => {
  const { class: _cls, ...rest } = props as unknown as Record<string, unknown>
  return rest as Omit<TreeItemProps<T>, 'class'>
})
</script>

<template>
  <TreeItem
    v-slot="slotProps"
    data-slot="tree-item"
    v-bind="delegatedProps"
    :class="cn('outline-none', props.class)"
  >
    <slot v-bind="slotProps" />
  </TreeItem>
</template>
