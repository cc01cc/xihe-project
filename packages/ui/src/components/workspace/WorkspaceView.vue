<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useWorkspaceStore } from '../../stores/workspace'
import { useSessionStore } from '../../stores/session'
import WorkspaceToolbar from './WorkspaceToolbar.vue'
import FileTreePanel from './FileTreePanel.vue'
import FileEditor from './FileEditor.vue'
import FileContextMenu from './FileContextMenu.vue'
import FileImportDialog from './FileImportDialog.vue'
import ChatPanel from '../chat/ChatPanel.vue'

const route = useRoute()
const ws = useWorkspaceStore()
const sessionStore = useSessionStore()
const contextMenu = ref<{ path: string; x: number; y: number } | null>(null)

const sessionId = computed(() => {
  const id = (route.params.sessionId as string) || sessionStore.currentSessionId
  if (id && !sessionStore.currentSessionId) {
    sessionStore.selectSession(id)
  }
  if (!id && !sessionStore.currentSessionId) {
    const session = sessionStore.createSession()
    return session.id
  }
  return id
})

watch(
  () => sessionId.value,
  (id) => {
    if (id) {
      sessionStore.selectSession(id)
    }
  },
  { immediate: true },
)

watch(
  () => ws.activeFilePath,
  () => {
    ws.syncActiveFileToSession()
  },
)

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

    <div
      v-if="sessionId"
      class="w-96 border-l bg-muted/5 flex flex-col shrink-0"
    >
      <ChatPanel :session-id="sessionId" />
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
