<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWorkspaceStore } from '../../stores/workspace'
import { useSessionStore } from '../../stores/session'
import { useAuthStore } from '../../stores/auth'
import { ApiError } from '../../composables/api'
import { logger } from '../../lib/logger'
import { toast } from 'vue-sonner'
import WorkspaceToolbar from './WorkspaceToolbar.vue'
import WorkspaceCreateDialog from './WorkspaceCreateDialog.vue'
import WorkspaceSettingsDialog from './WorkspaceSettingsDialog.vue'
import MobileWorkspaceSheet from './MobileWorkspaceSheet.vue'
import MobileChatSheet from './MobileChatSheet.vue'
import FileTreePanel from './FileTreePanel.vue'
import FileEditor from './FileEditor.vue'
import FileImportDialog from './FileImportDialog.vue'
import ChatPanel from '../chat/ChatPanel.vue'

const route = useRoute()
const router = useRouter()
const ws = useWorkspaceStore()
const sessionStore = useSessionStore()
const auth = useAuthStore()

const routeWorkspaceId = computed(() => (route.params.workspaceId as string | undefined) ?? '')

const showCreateDialog = ref(false)
const showSettingsDialog = ref(false)
const showMobileFiles = ref(false)

function handleWorkspaceCreated(id: string) {
  router.push(`/workspace/${id}`)
}

function handleWorkspaceDeleted() {
  sessionStore.resetForUserSwitch()
  router.push('/chat/default')
}

const sessionId = computed(() => {
  if (sessionStore.currentSessionId) return sessionStore.currentSessionId
  return null
})

const workspaceId = computed(() => routeWorkspaceId.value || auth.currentWorkspaceId || '')

async function ensureSessionForWorkspace() {
  if (!auth.currentWorkspaceId) return null
  if (sessionStore.currentSessionId) return sessionStore.currentSessionId
  try {
    // Direct workspace navigation can race App/ChatView session hydration.
    // Finish the canonical server projection before deciding to create one;
    // createSession itself is single-flight for the remaining empty case.
    await sessionStore.loadSessions()
    if (sessionStore.currentSessionId) return sessionStore.currentSessionId
    const existing = sessionStore.sessions.find(
      (session) => session.workspaceId === auth.currentWorkspaceId,
    )
    if (existing) {
      sessionStore.selectSession(existing.id)
      return existing.id
    }
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

function handleUpload() {
  ws.openImportDialog()
}

onMounted(() => {
  void ensureSessionForWorkspace()
})
</script>

<template>
  <!-- Empty state per PLAN-262 decision 11: only reachable when no active workspace.
       The create dialog is the sole creation entry (409 makes it purely defensive). -->
  <div v-if="!auth.workspace" class="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
    <div class="flex size-16 items-center justify-center rounded-2xl border border-dashed">
      <span class="i-lucide-folder-tree size-7 text-muted-foreground" />
    </div>
    <h2 class="text-lg font-semibold">暂无工作区</h2>
    <p class="max-w-sm text-sm text-muted-foreground">
      上一个工作区已删除。创建一个新的工作区开始使用文件、终端与 Agent 工具。
    </p>
    <button
      class="px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:opacity-90"
      @click="showCreateDialog = true"
    >
      Create workspace
    </button>
    <p class="max-w-md text-xs text-muted-foreground border-t border-dashed pt-3">
      每账号同时持有 1 个活动工作区 · 物理目录由系统按 hostRoot/workspaceId 派生，宿主机可直接访问
    </p>
    <WorkspaceCreateDialog
      :open="showCreateDialog"
      @close="showCreateDialog = false"
      @created="handleWorkspaceCreated"
    />
  </div>
  <div v-else class="flex h-full">
    <div class="w-60 shrink-0 border-r bg-muted/10 flex flex-col max-md:hidden">
      <FileTreePanel />
    </div>

    <div class="flex-1 flex flex-col min-w-0">
      <WorkspaceToolbar :workspace-id="workspaceId" @upload="handleUpload" @settings="showSettingsDialog = true" @files="showMobileFiles = true" />
      <FileEditor />
    </div>

    <div
      v-if="sessionId"
      class="w-96 border-l bg-muted/5 flex-col shrink-0 hidden md:flex"
    >
       <ChatPanel :session-id="sessionId" tool-mode="workspace" />
    </div>
    <div
      v-else
      class="w-96 border-l bg-muted/5 flex-col items-center justify-center gap-2 shrink-0 hidden md:flex"
    >
      <p class="text-sm text-muted-foreground">No active session</p>
      <button
        class="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90"
        @click="ensureSessionForWorkspace()"
      >
        New Chat
      </button>
    </div>

    <FileImportDialog v-if="ws.showImportDialog" />

    <WorkspaceSettingsDialog
      :open="showSettingsDialog"
      @close="showSettingsDialog = false"
      @deleted="handleWorkspaceDeleted"
    />

    <MobileWorkspaceSheet
      :open="showMobileFiles"
      @close="showMobileFiles = false"
    />

    <MobileChatSheet v-if="sessionId" :session-id="sessionId" />
  </div>
</template>
