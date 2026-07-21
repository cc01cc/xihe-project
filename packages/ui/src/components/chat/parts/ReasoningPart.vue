<script setup lang="ts">
import { ref } from 'vue'

defineProps<{
  content: string
}>()

const expanded = ref(false)
</script>

<template>
  <details
    class="my-2 rounded-lg border bg-muted/30 p-3"
    :open="expanded"
  >
    <summary
      class="cursor-pointer text-sm font-medium text-muted-foreground select-none"
      @click="expanded = !expanded"
    >
      Reasoning
    </summary>
    <div class="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{{ content }}</div>
  </details>
</template>
