<script setup lang="ts">
import { computed } from 'vue'
import type { FileNode } from '../../types'

const props = defineProps<{
  node: FileNode
  depth: number
  selectedPath: string | null
  expandedPaths: Set<string>
}>()

const emit = defineEmits<{
  select: [path: string]
  toggle: [path: string]
  contextmenu: [path: string, event: MouseEvent]
}>()

const indent = computed(() => `${props.depth * 16 + 8}px`)
const isExpanded = computed(() => props.expandedPaths.has(props.node.path))
const isSelected = computed(() => props.selectedPath === props.node.path)

function getIcon(): string {
  if (props.node.type === 'directory') return isExpanded.value ? 'i-lucide-folder-open' : 'i-lucide-folder'
  const ext = props.node.name.split('.').pop()?.toLowerCase()
  const map: Record<string, string> = {
    md: 'i-lucide-file-text', pdf: 'i-lucide-file-text',
    ts: 'i-lucide-file-code', tsx: 'i-lucide-file-code',
    js: 'i-lucide-file-code', jsx: 'i-lucide-file-code',
    py: 'i-lucide-file-code', rs: 'i-lucide-file-code',
    java: 'i-lucide-file-code', go: 'i-lucide-file-code',
    vue: 'i-lucide-file-code',
    json: 'i-lucide-file-json', yaml: 'i-lucide-file-json', yml: 'i-lucide-file-json',
    css: 'i-lucide-file-code', html: 'i-lucide-file-code',
    png: 'i-lucide-image', jpg: 'i-lucide-image', jpeg: 'i-lucide-image',
    gif: 'i-lucide-image', svg: 'i-lucide-image', webp: 'i-lucide-image',
    toml: 'i-lucide-settings', sql: 'i-lucide-database',
    sh: 'i-lucide-terminal', txt: 'i-lucide-file-text',
    log: 'i-lucide-file-text', csv: 'i-lucide-table',
  }
  return map[ext || ''] || 'i-lucide-file'
}

function handleClick() {
  if (props.node.type === 'directory') {
    emit('toggle', props.node.path)
  } else {
    emit('select', props.node.path)
  }
}

function handleContextmenu(e: MouseEvent) {
  emit('contextmenu', props.node.path, e)
}
</script>

<template>
  <div>
    <div
      class="flex items-center gap-1 py-1 text-sm cursor-pointer rounded hover:bg-accent/50 transition-colors select-none"
      :class="{ 'bg-accent text-accent-foreground': isSelected }"
      :style="{ paddingLeft: indent }"
      @click="handleClick"
      @contextmenu.prevent="handleContextmenu"
    >
      <span class="w-4 shrink-0 text-[10px] text-muted-foreground">
        {{ node.type === 'directory' ? (isExpanded ? '▼' : '▶') : '' }}
      </span>
      <span :class="[getIcon(), 'size-3.5 shrink-0']" />
      <span class="truncate flex-1 ml-1">{{ node.name }}</span>
    </div>
    <template v-if="node.type === 'directory' && isExpanded && node.children">
      <FileTreeNode
        v-for="child in node.children"
        :key="child.path"
        :node="child"
        :depth="depth + 1"
        :selected-path="selectedPath"
        :expanded-paths="expandedPaths"
        @select="(p: string) => emit('select', p)"
        @toggle="(p: string) => emit('toggle', p)"
        @contextmenu="(p: string, e: MouseEvent) => emit('contextmenu', p, e)"
      />
    </template>
  </div>
</template>
