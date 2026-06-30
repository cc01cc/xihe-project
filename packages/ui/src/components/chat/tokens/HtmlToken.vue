<script setup lang="ts">
import type { Tokens } from 'marked'

defineProps<{
  token: Tokens.HTML | Tokens.Tag
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
  <span class="text-sm">{{ escapeHtml(token.text) }}</span>
</template>
