<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useWorkspaceStore } from '../../stores/workspace'
import { useSessionStore } from '../../stores/session'
import { useAuthStore } from '../../stores/auth'
import { ApiError } from '../../composables/api'
import { logger } from '../../lib/logger'
import { toast } from 'vue-sonner'
import { FolderTree, X } from '@lucide/vue'
import { useMediaQuery } from '@vueuse/core'
import WorkspaceToolbar from './WorkspaceToolbar.vue'
import WorkspaceCreateDialog from './WorkspaceCreateDialog.vue'
import WorkspaceSettingsDialog from './WorkspaceSettingsDialog.vue'
import MobileWorkspaceSheet from './MobileWorkspaceSheet.vue'
import MobileChatSheet from './MobileChatSheet.vue'
import MobileChangesSheet from './MobileChangesSheet.vue'
import FileTreePanel from './FileTreePanel.vue'
import FileEditor from './FileEditor.vue'
import FileImportDialog from './FileImportDialog.vue'
import WorkspaceChangesPanel from './WorkspaceChangesPanel.vue'
import ChatPanel from '../chat/ChatPanel.vue'

const route = useRoute()
const router = useRouter()
const ws = useWorkspaceStore()
const sessionStore = useSessionStore()
const auth = useAuthStore()
const { t } = useI18n()
const isMobileViewport = useMediaQuery('(max-width: 767px)')

const routeWorkspaceId = computed(() => (route.params.workspaceId as string | undefined) ?? '')

const showCreateDialog = ref(false)
const showSettingsDialog = ref(false)
const showMobileFiles = ref(false)
const showMobileChanges = ref(false)

// ── PLAN-0328 M3 T3.7 (spec/ui-ux §1.3): conversation-first workspace layout ──────────────
// The chat timeline is the main column; the file tree collapses into a narrow rail and the
// editor / dual-diff live in one collapsible auxiliary panel (default collapsed). Panel state
// is remembered per session in-component only (never persisted).
type AuxPanel = 'closed' | 'code' | 'changes'
const treeCollapsed = ref(false)
const auxPanel = ref<AuxPanel>('closed')
const layoutBySession = new Map<string, { treeCollapsed: boolean; auxPanel: AuxPanel }>()

function layoutKey(id: string | null): string {
  return id ?? '__none__'
}

function toggleTree() {
  treeCollapsed.value = !treeCollapsed.value
}

function toggleAux(panel: Exclude<AuxPanel, 'closed'>) {
  auxPanel.value = auxPanel.value === panel ? 'closed' : panel
}

function handleToggleChanges() {
  if (isMobileViewport.value) {
    showMobileChanges.value = !showMobileChanges.value
    return
  }
  toggleAux('changes')
}

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

// Remember the layout toggles per session (in-component only): switching sessions restores the
// state the user left that session in, without persisting anything across reloads.
watch(
  () => sessionId.value,
  (id, previous) => {
    layoutBySession.set(layoutKey(previous ?? null), {
      treeCollapsed: treeCollapsed.value,
      auxPanel: auxPanel.value,
    })
    const restored = layoutBySession.get(layoutKey(id ?? null))
    treeCollapsed.value = restored?.treeCollapsed ?? false
    auxPanel.value = restored?.auxPanel ?? 'closed'
  },
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
       <FolderTree class="size-7 text-muted-foreground" aria-hidden="true" />
    </div>
    <h2 class="text-lg font-semibold">暂无工作区</h2>
    <p class="max-w-sm text-sm text-muted-foreground">
      上一个工作区已删除。创建一个新的工作区开始使用文件、终端与 Agent 工具。
    </p>
    <button
      class="px-4 py-2 text-sm rounded bg-primary text-primary-foreground hover:opacity-90"
      @click="showCreateDialog = true"
    >
       创建工作区
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
  <div v-else class="flex h-full min-w-0">
    <!-- File tree: 240px tree ⇄ narrow rail (desktop; mobile keeps the Files sheet). -->
    <div
      class="flex shrink-0 flex-col border-r bg-muted/10 max-md:hidden"
      :class="treeCollapsed ? 'w-10' : 'w-60'"
      data-testid="workspace-file-rail"
    >
      <div v-if="treeCollapsed" class="flex flex-col items-center gap-1 py-2">
        <button
          type="button"
          data-testid="workspace-tree-expand"
          class="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :title="t('workspace.expandFiles')"
          :aria-label="t('workspace.expandFiles')"
          @click="treeCollapsed = false"
        >
          <FolderTree class="size-4" aria-hidden="true" />
        </button>
      </div>
      <div v-else class="flex h-full min-h-0 flex-1 flex-col" data-testid="workspace-file-tree">
        <FileTreePanel />
      </div>
    </div>

    <div class="flex min-w-0 flex-1 flex-col">
      <WorkspaceToolbar
        :workspace-id="workspaceId"
        :tree-collapsed="treeCollapsed"
        :code-open="!isMobileViewport && auxPanel === 'code'"
        :changes-open="isMobileViewport ? showMobileChanges : auxPanel === 'changes'"
        @upload="handleUpload"
        @settings="showSettingsDialog = true"
        @files="showMobileFiles = true"
        @toggle-tree="toggleTree"
        @toggle-code="toggleAux('code')"
        @toggle-changes="handleToggleChanges"
      />

      <div class="flex min-h-0 min-w-0 flex-1">
        <!-- Conversation is the main column (desktop). -->
        <div
          v-if="!isMobileViewport"
          class="flex min-w-0 flex-1 flex-col"
          data-testid="workspace-conversation"
        >
          <div
            class="h-9 shrink-0 border-b px-3 flex items-center gap-2 text-xs text-muted-foreground bg-muted/5"
            :title="`workspace=${workspaceId}`"
          >
            <span class="font-medium text-foreground/80">{{ auth.workspace?.name ?? t('workspace.chatHeader') }}</span>
            <span class="text-muted-foreground/60">{{ t('workspace.chatHeader') }}</span>
          </div>
          <ChatPanel v-if="sessionId" :session-id="sessionId" tool-mode="workspace" />
          <div v-else class="flex flex-1 flex-col items-center justify-center gap-2">
            <p class="text-sm text-muted-foreground">{{ t('workspace.noSession') }}</p>
            <button
              class="px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90"
              data-testid="workspace-create-session"
              @click="ensureSessionForWorkspace()"
            >
              {{ t('workspace.createSession') }}
            </button>
          </div>
        </div>

        <!-- Mobile keeps the existing editor-first body with files/chat as sheets. -->
        <div v-else class="flex min-w-0 flex-1 flex-col">
          <FileEditor />
        </div>

        <!-- Collapsible auxiliary panel (desktop): code editor or the dual-diff panel. -->
        <div
          v-if="!isMobileViewport && auxPanel !== 'closed'"
          data-testid="workspace-aux-panel"
          class="flex w-[30rem] max-w-[60%] shrink-0 flex-col border-l bg-background"
        >
          <div class="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs">
            <span class="font-medium text-foreground/80">
              {{ auxPanel === 'code' ? t('workspace.panelCode') : t('workspace.panelChanges') }}
            </span>
            <button
              type="button"
              data-testid="workspace-aux-close"
              class="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              :title="t('workspace.closePanel')"
              :aria-label="t('workspace.closePanel')"
              @click="auxPanel = 'closed'"
            >
              <X class="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <div class="flex min-h-0 flex-1 flex-col">
            <FileEditor v-if="auxPanel === 'code'" />
            <WorkspaceChangesPanel
              v-else
              :session-id="sessionId"
              :workspace-id="workspaceId"
              @close="auxPanel = 'closed'"
            />
          </div>
        </div>
      </div>
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

    <MobileChangesSheet
      :open="showMobileChanges"
      :session-id="sessionId"
      :workspace-id="workspaceId"
      @close="showMobileChanges = false"
    />

    <MobileChatSheet v-if="sessionId" :session-id="sessionId" />
  </div>
</template>
