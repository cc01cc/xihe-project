<script setup lang="ts">
import { computed } from 'vue'
import { useMarkdown } from '@/composables/useMarkdown'
import MarkdownTokens from './tokens/MarkdownTokens.vue'
import { provideMarkdownContext } from './tokens/markdownContext'

const props = defineProps<{
  content: string
  isStreaming?: boolean
}>()

const isStreaming = computed(() => props.isStreaming ?? false)

provideMarkdownContext({ isStreaming })

const { tokens } = useMarkdown(
  () => props.content,
  isStreaming,
)
</script>

<template>
  <div class="prose prose-sm max-w-none">
    <MarkdownTokens :tokens="tokens" />
  </div>
</template>
