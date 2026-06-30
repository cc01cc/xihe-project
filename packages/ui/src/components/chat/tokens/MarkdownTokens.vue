<script setup lang="ts">
import type { MarkdownToken } from '@/services/markdownParser'
import { resolveTokenComponent } from './tokenRegistry'

defineProps<{
  tokens: MarkdownToken[]
}>()

function stableKey(token: MarkdownToken, index: number): string {
  const rawPrefix = (token.raw ?? '').slice(0, 60)
  return `${token.type}-${rawPrefix}-${index}`
}
</script>

<template>
  <component
    :is="resolveTokenComponent(token.type)"
    v-for="(token, index) in tokens"
    :key="stableKey(token, index)"
    :token="token"
  />
</template>
