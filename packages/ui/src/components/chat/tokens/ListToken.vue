<script setup lang="ts">
import type { Tokens } from 'marked'
import MarkdownTokens from './MarkdownTokens.vue'

const props = defineProps<{
  token: Tokens.List
}>()

const listTag = props.token.ordered ? 'ol' : 'ul'
const listClass = props.token.ordered
  ? 'list-decimal pl-6 my-1 space-y-1'
  : 'list-disc pl-6 my-1 space-y-1'
</script>

<template>
  <component :is="listTag" :class="listClass">
    <li
      v-for="(item, index) in token.items"
      :key="index"
      class="leading-relaxed"
    >
      <input
        v-if="item.task"
        type="checkbox"
        :checked="item.checked"
        disabled
        class="mr-2 align-middle"
      >
      <MarkdownTokens :tokens="item.tokens" />
    </li>
  </component>
</template>
