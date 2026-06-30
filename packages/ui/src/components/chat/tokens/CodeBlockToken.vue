<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import hljs from 'highlight.js'
import type { Tokens } from 'marked'
import { logger } from '@/lib/logger'
import CodeBlock from '../CodeBlock.vue'
import { useMarkdownContext } from './markdownContext'

const props = defineProps<{
  token: Tokens.Code
}>()

const { isStreaming } = useMarkdownContext()
const highlightedHtml = ref('')

const lang = computed(() => props.token.lang ?? 'text')
const code = computed(() => props.token.text ?? '')

function syncHighlight() {
  try {
    const result = lang.value !== 'text' && hljs.getLanguage(lang.value)
      ? hljs.highlight(code.value, { language: lang.value, ignoreIllegals: true })
      : hljs.highlightAuto(code.value)
    highlightedHtml.value = result.value
  } catch (error) {
    logger.warn('highlight.js failed', error)
    highlightedHtml.value = escapeHtml(code.value)
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

async function asyncShikiHighlight() {
  try {
    const { createHighlighter } = await import('shiki')
    const highlighter = await createHighlighter({
      themes: ['github-dark', 'github-light'],
      langs: ['typescript', 'javascript', 'python', 'html', 'css', 'json', 'yaml', 'bash', 'shell', 'sql', 'markdown', 'xml', 'vue', 'jsx', 'tsx'],
    })
    highlightedHtml.value = highlighter.codeToHtml(code.value, {
      lang: lang.value || 'text',
      theme: 'github-dark',
    })
  } catch (error) {
    logger.warn('Shiki highlight failed, falling back to highlight.js', error)
    syncHighlight()
  }
}

watch(
  () => [code.value, lang.value, isStreaming],
  () => {
    if (isStreaming) {
      syncHighlight()
    } else {
      asyncShikiHighlight()
    }
  },
  { immediate: true },
)
</script>

<template>
  <CodeBlock
    :code="code"
    :lang="lang"
    :highlighted-html="highlightedHtml"
  />
</template>
