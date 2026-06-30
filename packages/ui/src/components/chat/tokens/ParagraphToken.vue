<script setup lang="ts">
import type { Tokens } from 'marked'
import MarkdownTokens from './MarkdownTokens.vue'

defineProps<{
  token: Tokens.Paragraph
}>()
</script>

<template>
  <p class="my-1.5 leading-relaxed">
    <MarkdownTokens :tokens="token.tokens" />
  </p>
</template>
