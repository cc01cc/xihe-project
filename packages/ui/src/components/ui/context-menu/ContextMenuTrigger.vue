<script setup lang="ts">
import { ContextMenuTrigger, type ContextMenuTriggerProps } from "reka-ui"

defineProps<ContextMenuTriggerProps>()
</script>

<template>
  <ContextMenuTrigger data-slot="context-menu-trigger">
    <slot />
  </ContextMenuTrigger>
</template>
