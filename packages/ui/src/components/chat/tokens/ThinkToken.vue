<script setup lang="ts">
import { ref } from 'vue'
import type { MarkdownToken } from '@/services/markdownParser'
import type { ThinkToken } from '@/services/markedThinkExtension'

const props = defineProps<{
  token: MarkdownToken
}>()

const expanded = ref(false)
const think = props.token as ThinkToken
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
    <div class="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{{ think.text }}</div>
  </details>
</template>
