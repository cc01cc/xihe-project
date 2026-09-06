<script setup lang="ts">
import { computed } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import type { FileNode } from '../../types'
import Tree from '../ui/tree/Tree.vue'
import TreeNodeList from './TreeNodeList.vue'

const props = withDefaults(defineProps<{
  searchQuery?: string
}>(), {
  searchQuery: '',
})

const ws = useWorkspaceStore()

const expandedArray = computed({
  get: () => Array.from(ws.expandedPaths),
  set: (next: string[]) => {
    ws.expandedPaths = new Set(next)
  },
})

/** Frontend filter over the loaded tree (M3 task 3.5): matches name substring,
 *  keeps ancestors of matches, and auto-expands them. Empty query = full tree. */
const displayTree = computed((): FileNode[] => {
  const q = props.searchQuery.trim().toLowerCase()
  if (!q) return ws.fileTree
  const filter = (nodes: FileNode[]): FileNode[] => {
    const out: FileNode[] = []
    for (const n of nodes) {
      const children = n.children ? filter(n.children) : undefined
      if (n.name.toLowerCase().includes(q) || (children && children.length > 0)) {
        out.push({ ...n, children: children ?? n.children })
      }
    }
    return out
  }
  return filter(ws.fileTree)
})

const searchExpanded = computed(() => {
  if (!props.searchQuery.trim()) return expandedArray.value
  const keys = new Set<string>()
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.type === 'directory') keys.add(n.path)
      if (n.children) walk(n.children)
    }
  }
  walk(displayTree.value)
  return Array.from(new Set([...expandedArray.value, ...keys]))
})
</script>

<template>
  <Tree
    :expanded="searchExpanded"
    :items="displayTree"
    :get-key="(node: FileNode) => node.path"
    :get-children="(node: FileNode) => node.children"
    class="py-1"
    @update:expanded="(next: string[]) => { if (!props.searchQuery.trim()) expandedArray = next }"
  >
    <TreeNodeList :nodes="displayTree" :level="0" :search-query="searchQuery" />
  </Tree>
</template>
