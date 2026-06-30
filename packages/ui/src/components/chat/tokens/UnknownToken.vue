<script setup lang="ts">
import type { MarkdownToken } from '@/services/markdownParser'

defineProps<{
  token: MarkdownToken
}>()

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}
</script>

<template>
  <pre class="my-2 p-2 rounded bg-muted text-xs overflow-x-auto">{{ escapeHtml(JSON.stringify(token, null, 2)) }}</pre>
</template>
