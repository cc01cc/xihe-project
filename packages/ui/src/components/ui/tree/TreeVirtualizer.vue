<script setup lang="ts">
import { TreeVirtualizer, type TreeVirtualizerProps } from "reka-ui"

defineProps<TreeVirtualizerProps>()
</script>

<template>
  <TreeVirtualizer
    v-slot="slotProps"
    data-slot="tree-virtualizer"
  >
    <slot v-bind="slotProps" />
  </TreeVirtualizer>
</template>
