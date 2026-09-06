<script setup lang="ts" generic="T extends Record<string, any>">
import { TreeRoot, useForwardPropsEmits, type TreeRootEmits, type TreeRootProps } from "reka-ui"

const props = defineProps<TreeRootProps<T>>()
const emits = defineEmits<TreeRootEmits<T>>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <TreeRoot
    v-slot="slotProps"
    data-slot="tree"
    v-bind="forwarded"
  >
    <slot v-bind="slotProps" />
  </TreeRoot>
</template>
