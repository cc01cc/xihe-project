<script setup lang="ts">
import { onMounted } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import FileTreeNode from './FileTreeNode.vue'

const emit = defineEmits<{
  contextmenu: [path: string, event: MouseEvent]
}>()

const ws = useWorkspaceStore()

onMounted(() => {
  if (ws.fileTree.length === 0) {
    ws.loadTree()
  }
})

function handleSelect(path: string) {
  ws.openFile(path)
}

function handleToggle(path: string) {
  ws.toggleExpand(path)
}

function handleContextmenu(path: string, event: MouseEvent) {
  emit('contextmenu', path, event)
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="flex items-center justify-between px-3 py-2 border-b shrink-0">
      <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">Files</span>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground transition-colors"
        title="Refresh"
        @click="ws.refreshTree()"
      >
        <span class="i-lucide-refresh-cw size-3.5" />
      </button>
    </div>

    <div v-if="ws.loading" class="flex-1 flex items-center justify-center">
      <span class="i-lucide-loader-circle size-5 animate-spin text-muted-foreground" />
    </div>

    <div v-else-if="ws.treeError" class="flex-1 flex flex-col items-center justify-center gap-2 p-4">
      <p class="text-sm text-destructive">{{ ws.treeError }}</p>
      <button
        class="px-3 py-1 text-xs rounded bg-primary text-primary-foreground"
        @click="ws.loadTree()"
      >
        Retry
      </button>
    </div>

    <div v-else-if="ws.fileTree.length === 0" class="flex-1 flex items-center justify-center">
      <p class="text-sm text-muted-foreground">Workspace is empty</p>
    </div>

    <div v-else class="flex-1 overflow-y-auto py-1">
      <FileTreeNode
        v-for="node in ws.fileTree"
        :key="node.path"
        :node="node"
        :depth="0"
        :selected-path="ws.activeFilePath"
        :expanded-paths="ws.expandedPaths"
        @select="handleSelect"
        @toggle="handleToggle"
        @contextmenu="handleContextmenu"
      />
    </div>
  </div>
</template>
