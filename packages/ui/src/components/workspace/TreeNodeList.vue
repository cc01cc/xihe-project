<script setup lang="ts">
import type { Component } from 'vue'
import {
  Database,
  File,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Settings2,
  Table2,
  Terminal,
} from '@lucide/vue'
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

function getIcon(node: FileNode, isExpanded: boolean): Component {
  if (node.type === 'directory') return isExpanded ? FolderOpen : Folder
  const ext = node.name.split('.').pop()?.toLowerCase()
  const map: Record<string, Component> = {
    md: FileText, pdf: FileText,
    ts: FileCode2, tsx: FileCode2,
    js: FileCode2, jsx: FileCode2,
    py: FileCode2, rs: FileCode2,
    java: FileCode2, go: FileCode2,
    vue: FileCode2,
    json: FileJson, yaml: FileJson, yml: FileJson,
    css: FileCode2, html: FileCode2,
    png: Image, jpg: Image, jpeg: Image,
    gif: Image, svg: Image, webp: Image,
    toml: Settings2, sql: Database,
    sh: Terminal, txt: FileText,
    log: FileText, csv: Table2,
  }
  return map[ext || ''] || File
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
      <TreeItem v-slot="{ isExpanded }" :value="node" :level="level" @select="handleSelect(node)">
        <FileNodeMenu :node="node">
          <button
            class="flex w-full items-center gap-1 py-1 text-sm rounded hover:bg-accent/50 transition-colors select-none text-left"
            :class="{ 'bg-accent text-accent-foreground': ws.activeFilePath === node.path }"
            :style="{ paddingLeft: `${level * 16 + 8}px` }"
          >
            <span class="w-4 shrink-0 text-[10px] text-muted-foreground">
              {{ node.type === 'directory' ? (isExpanded ? '▼' : '▶') : '' }}
            </span>
            <component :is="getIcon(node, isExpanded)" class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span v-if="!searchQuery" class="truncate flex-1 ml-1">{{ node.name }}</span>
            <span v-else class="truncate flex-1 ml-1" v-html="highlightName(node.name, searchQuery)" />
          </button>
        </FileNodeMenu>
        <TreeNodeList
          v-if="isExpanded && node.children && node.children.length > 0"
          :nodes="node.children"
          :level="level + 1"
          :search-query="searchQuery"
        />
      </TreeItem>
    </li>
  </ul>
</template>
