<script setup lang="ts">
import type { MessagePart } from '@/types'

const props = defineProps<{
  part: Extract<MessagePart, { type: 'artifact' }>
}>()
</script>

<template>
  <div class="my-2 rounded-lg border bg-muted/30 p-3">
    <div class="text-xs font-medium text-muted-foreground mb-1">
      Artifact {{ part.identifier ? `(${part.identifier})` : '' }}
    </div>
    <pre class="text-xs overflow-x-auto">{{ part.content }}</pre>
  </div>
</template>
