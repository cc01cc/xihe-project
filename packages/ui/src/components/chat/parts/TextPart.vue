<script setup lang="ts">
import MarkdownRender from 'markstream-vue'

defineProps<{
  content: string
  isStreaming?: boolean
}>()
</script>

<template>
  <MarkdownRender
    class="xihe-chat-markdown"
    mode="chat"
    :content="content"
    :final="!isStreaming"
    custom-id="xihe"
  />
</template>
