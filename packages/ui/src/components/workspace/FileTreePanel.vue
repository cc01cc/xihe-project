<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { LoaderCircle, RefreshCw, Search, X } from '@lucide/vue'
import { useWorkspaceStore } from '../../stores/workspace'
import FileTree from './FileTree.vue'

const ws = useWorkspaceStore()
const searchQuery = ref('')

onMounted(() => {
  void ws.loadTree()
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
        <Search class="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
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
          <X class="size-3" />
        </button>
      </div>
      <button
        class="p-1 rounded hover:bg-accent text-muted-foreground transition-colors"
        title="Refresh"
        @click="ws.refreshTree()"
      >
        <RefreshCw class="size-3.5" />
      </button>
    </div>

    <div v-if="ws.loading" data-testid="workspace-tree-loading" class="flex-1 flex items-center justify-center">
       <LoaderCircle class="size-5 animate-spin text-muted-foreground" aria-hidden="true" />
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

    <div v-else-if="ws.fileTree.length === 0" data-testid="workspace-empty-state" class="flex-1 flex items-center justify-center">
       <p class="text-sm text-muted-foreground">工作区暂无文件</p>
    </div>

    <div v-else class="flex-1 overflow-y-auto py-1 px-1">
      <FileTree :search-query="filteredTree?.query ?? ''" />
    </div>
  </div>
</template>
