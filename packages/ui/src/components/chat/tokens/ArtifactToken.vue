<script setup lang="ts">
import type { MarkdownToken } from '@/services/markdownParser'
import type { ArtifactToken } from '@/services/markedArtifactExtension'

const props = defineProps<{
  token: MarkdownToken
}>()

const artifact = props.token as ArtifactToken
</script>

<template>
  <div class="my-2 rounded-lg border bg-muted/30 p-3">
    <div class="text-xs font-medium text-muted-foreground mb-1">
      Artifact {{ artifact.identifier ? `(${artifact.identifier})` : '' }}
    </div>
    <pre class="text-xs overflow-x-auto">{{ artifact.content }}</pre>
  </div>
</template>
