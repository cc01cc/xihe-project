<script setup lang="ts">
import type { MarkdownToken } from '@/services/markdownParser'
import type { CitationToken } from '@/services/markedCitationExtension'

const props = defineProps<{
  token: MarkdownToken
}>()

const citation = props.token as CitationToken
</script>

<template>
  <sup class="ml-0.5 text-xs text-primary cursor-pointer hover:underline">
    [{{ citation.index }}]
  </sup>
</template>
