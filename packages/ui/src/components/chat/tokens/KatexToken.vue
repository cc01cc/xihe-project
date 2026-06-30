<script setup lang="ts">
import { computed } from 'vue'
import katex from 'katex'
import type { MarkdownToken } from '@/services/markdownParser'
import type { InlineKatexToken, BlockKatexToken } from '@/services/markedKatexExtension'
import { logger } from '@/lib/logger'

const props = defineProps<{
  token: MarkdownToken
}>()

const isBlock = computed(() => props.token.type === 'blockKatex')
const formula = computed(() => {
  if (props.token.type === 'inlineKatex') {
    return (props.token as InlineKatexToken).text
  }
  return (props.token as BlockKatexToken).text
})

const rendered = computed(() => {
  try {
    return katex.renderToString(formula.value, {
      displayMode: isBlock.value,
      throwOnError: false,
    })
  } catch (error) {
    logger.warn('KaTeX render failed', error)
    return `<pre class="text-red-500">${formula.value}</pre>`
  }
})
</script>

<template>
  <span
    class="katex-wrapper"
    :class="isBlock ? 'block my-2 overflow-x-auto' : 'inline'"
    v-html="rendered"
  />
</template>
