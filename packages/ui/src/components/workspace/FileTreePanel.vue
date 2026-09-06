<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import FileTree from './FileTree.vue'

const ws = useWorkspaceStore()
const searchQuery = ref('')

onMounted(() => {
  if (ws.fileTree.length === 0) {
    ws.loadTree()
  }
})

const filteredTree = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return null
  return { query: q }
})

function clearSearch() {
  searchQuery.value = ''
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="flex items-center gap-1 px-2 py-2 border-b shrink-0">
      <div class="relative flex-1">
        <span class="i-lucide-search absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
        <input
          v-model="searchQuery"
          placeholder="过滤文件树"
          class="w-full pl-7 pr-6 py-1 text-xs rounded border bg-background placeholder:text-muted-foreground focus:outline-none"
        />
        <button
          v-if="searchQuery"
          class="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-accent text-muted-foreground"
          title="Clear"
          @click="clearSearch"
        >
          <span class="i-lucide-x size-3" />
        </button>
      </div>
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

    <div v-else class="flex-1 overflow-y-auto py-1 px-1">
      <FileTree :search-query="filteredTree?.query ?? ''" />
    </div>
  </div>
</template>
