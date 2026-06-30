<script setup lang="ts">
import type { Tokens } from 'marked'
import MarkdownTokens from './MarkdownTokens.vue'

defineProps<{
  token: Tokens.Blockquote
}>()
</script>

<template>
  <blockquote class="my-2 pl-4 border-l-4 border-muted italic">
    <MarkdownTokens :tokens="token.tokens" />
  </blockquote>
</template>
