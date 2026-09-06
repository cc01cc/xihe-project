<script setup lang="ts">
import { useWorkspaceStore } from '../../stores/workspace'
import type { FileNode } from '../../types'
import TreeItem from '../ui/tree/TreeItem.vue'
import FileNodeMenu from './FileNodeMenu.vue'

defineProps<{
  nodes: FileNode[]
  level: number
  searchQuery?: string
}>()

const ws = useWorkspaceStore()

function getIcon(node: FileNode, isExpanded: boolean): string {
  if (node.type === 'directory') return isExpanded ? 'i-lucide-folder-open' : 'i-lucide-folder'
  const ext = node.name.split('.').pop()?.toLowerCase()
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

function handleSelect(node: FileNode) {
  if (node.type === 'directory') return
  ws.openFile(node.path)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function highlightName(name: string, query?: string): string {
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return escapeHtml(name)
  const idx = name.toLowerCase().indexOf(q)
  if (idx < 0) return escapeHtml(name)
  return `${escapeHtml(name.substring(0, idx))}<b class="bg-yellow-200 dark:bg-yellow-800 rounded-sm px-px">${escapeHtml(name.substring(idx, idx + q.length))}</b>${escapeHtml(name.substring(idx + q.length))}`
}
</script>

<template>
  <ul>
    <li v-for="node in nodes" :key="node.path">
      <TreeItem v-slot="{ isExpanded }" as-child :value="node" :level="level" @select="handleSelect(node)">
        <FileNodeMenu :node="node">
          <button
            class="flex w-full items-center gap-1 py-1 text-sm rounded hover:bg-accent/50 transition-colors select-none text-left"
            :class="{ 'bg-accent text-accent-foreground': ws.activeFilePath === node.path }"
            :style="{ paddingLeft: `${level * 16 + 8}px` }"
          >
            <span class="w-4 shrink-0 text-[10px] text-muted-foreground">
              {{ node.type === 'directory' ? (isExpanded ? '▼' : '▶') : '' }}
            </span>
            <span :class="[getIcon(node, isExpanded), 'size-3.5 shrink-0']" />
            <span v-if="!searchQuery" class="truncate flex-1 ml-1">{{ node.name }}</span>
            <span v-else class="truncate flex-1 ml-1" v-html="highlightName(node.name, searchQuery)" />
          </button>
        </FileNodeMenu>
      </TreeItem>
      <TreeNodeList v-if="node.children && node.children.length > 0" :nodes="node.children" :level="level + 1" :search-query="searchQuery" />
    </li>
  </ul>
</template>
