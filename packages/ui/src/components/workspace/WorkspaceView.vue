<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useWorkspaceStore } from '../../stores/workspace'
import { useSessionStore } from '../../stores/session'
import { useAuthStore } from '../../stores/auth'
import { ApiError } from '../../composables/api'
import { logger } from '../../lib/logger'
import { toast } from 'vue-sonner'
import WorkspaceToolbar from './WorkspaceToolbar.vue'
import FileTreePanel from './FileTreePanel.vue'
import FileEditor from './FileEditor.vue'
import FileContextMenu from './FileContextMenu.vue'
import FileImportDialog from './FileImportDialog.vue'
import ChatPanel from '../chat/ChatPanel.vue'

const route = useRoute()
const ws = useWorkspaceStore()
const sessionStore = useSessionStore()
const auth = useAuthStore()
const contextMenu = ref<{ path: string; x: number; y: number } | null>(null)

const routeWorkspaceId = computed(() => (route.params.workspaceId as string | undefined) ?? '')

const sessionId = computed(() => {
  if (sessionStore.currentSessionId) return sessionStore.currentSessionId
  return null
})

const workspaceId = computed(() => routeWorkspaceId.value || auth.currentWorkspaceId || '')

async function ensureSessionForWorkspace() {
  if (!auth.currentWorkspaceId) return null
  if (sessionStore.currentSessionId) return sessionStore.currentSessionId
  try {
    const session = await sessionStore.createSession()
    return session.id
  } catch (cause) {
    const message = cause instanceof ApiError ? cause.message : 'Failed to create session'
    logger.error('Create session failed', cause)
    toast.error(message)
    return null
  }
}

watch(
  () => sessionId.value,
  (id) => {
    if (id) sessionStore.selectSession(id)
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

onMounted(() => {
  void ensureSessionForWorkspace()
})
</script>

<template>
  <div class="flex h-full">
    <div class="w-60 shrink-0 border-r bg-muted/10 flex flex-col">
      <FileTreePanel @contextmenu="handleContextmenu" />
    </div>

    <div class="flex-1 flex flex-col min-w-0">
      <WorkspaceToolbar :workspace-id="workspaceId" @upload="handleUpload" />
      <FileEditor />
    </div>

    <div
      v-if="sessionId"
      class="w-96 border-l bg-muted/5 flex flex-col shrink-0"
    >
      <ChatPanel :session-id="sessionId" />
    </div>
    <div
      v-else
      class="w-96 border-l bg-muted/5 flex flex-col items-center justify-center gap-2 shrink-0"
    >
      <p class="text-sm text-muted-foreground">No active session</p>
      <button
        class="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90"
        @click="ensureSessionForWorkspace()"
      >
        New Chat
      </button>
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
