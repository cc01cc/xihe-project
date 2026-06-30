<script setup lang="ts">
import { ref } from 'vue'
import { useWorkspaceStore } from '../../stores/workspace'
import WorkspaceToolbar from './WorkspaceToolbar.vue'
import FileTreePanel from './FileTreePanel.vue'
import FileEditor from './FileEditor.vue'
import FileContextMenu from './FileContextMenu.vue'
import FileImportDialog from './FileImportDialog.vue'

const ws = useWorkspaceStore()
const contextMenu = ref<{ path: string; x: number; y: number } | null>(null)

function handleContextmenu(path: string, event: MouseEvent) {
  contextMenu.value = { path, x: event.clientX, y: event.clientY }
}

function handleUpload() {
  ws.openImportDialog()
}
</script>

<template>
  <div class="flex h-full">
    <div class="w-60 shrink-0 border-r bg-muted/10 flex flex-col">
      <FileTreePanel @contextmenu="handleContextmenu" />
    </div>

    <div class="flex-1 flex flex-col min-w-0">
      <WorkspaceToolbar @upload="handleUpload" />
      <FileEditor />
    </div>

    <FileContextMenu
      v-if="contextMenu"
      :path="contextMenu.path"
      :x="contextMenu.x"
      :y="contextMenu.y"
      @close="contextMenu = null"
    />

    <FileImportDialog v-if="ws.showImportDialog" />
  </div>
</template>
