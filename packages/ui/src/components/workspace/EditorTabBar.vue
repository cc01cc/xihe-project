<script setup lang="ts">
import type { OpenFile } from '../../types'

defineProps<{
  openFiles: OpenFile[]
  activePath: string | null
}>()

const emit = defineEmits<{
  select: [path: string]
  close: [path: string]
}>()
</script>

<template>
  <div
    v-if="openFiles.length > 0"
    class="flex items-center border-b bg-muted/20 shrink-0 overflow-x-auto"
  >
    <button
      v-for="file in openFiles"
      :key="file.path"
      class="flex items-center gap-1.5 px-3 py-1.5 text-xs border-r hover:bg-accent/50 transition-colors shrink-0"
      :class="file.path === activePath ? 'bg-background font-medium' : 'text-muted-foreground'"
      @click="emit('select', file.path)"
    >
      <span>{{ file.modified ? '●' : '' }}</span>
      <span class="truncate max-w-24">{{ file.name }}</span>
      <button
        class="ml-1 p-0.5 rounded hover:bg-accent hover:text-foreground"
          aria-label="Close tab"
          @click.stop="emit('close', file.path)"
        >
        <span class="i-lucide-x size-3" />
      </button>
    </button>
  </div>
</template>
