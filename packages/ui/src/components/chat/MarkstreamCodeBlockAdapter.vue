<script setup lang="ts">
import { computed, provide } from 'vue'
import { markdownContextKey } from './tokens/markdownContext'
import CodeBlockToken, { type CodeToken } from './tokens/CodeBlockToken.vue'

const props = defineProps<{
  node?: { language?: string; code?: string; loading?: boolean }
  loading?: boolean
  language?: string
  code?: string
}>()

const lang = computed(() => props.node?.language ?? props.language ?? 'text')
const code = computed(() => props.node?.code ?? props.code ?? '')
const isLoading = computed(() => props.loading ?? props.node?.loading ?? false)

const adaptedToken: CodeToken = {
  get lang() { return lang.value },
  get text() { return code.value },
}

provide(markdownContextKey, { isStreaming: isLoading.value })
</script>

<template>
  <CodeBlockToken :token="adaptedToken" />
</template>
