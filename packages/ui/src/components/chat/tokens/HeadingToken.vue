<script setup lang="ts">
import type { Tokens } from 'marked'
import MarkdownTokens from './MarkdownTokens.vue'

const props = defineProps<{
  token: Tokens.Heading
}>()

const sizeClass = {
  1: 'text-xl',
  2: 'text-lg',
  3: 'text-base',
  4: 'text-base',
  5: 'text-sm',
  6: 'text-sm',
}[props.token.depth] ?? 'text-base'
</script>

<template>
  <component
    :is="`h${token.depth}`"
    class="font-semibold mt-4 mb-2 leading-snug"
    :class="sizeClass"
  >
    <MarkdownTokens :tokens="token.tokens" />
  </component>
</template>
