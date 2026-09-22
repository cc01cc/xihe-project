<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useWorkspaceStore } from '../../stores/workspace'
import { useSessionStore } from '../../stores/session'
import { useAuthStore } from '../../stores/auth'
import { Code, FileDiff, FolderOpen, FolderTree, PanelLeft, Plus, RefreshCw, Settings2, Upload } from '@lucide/vue'

const props = defineProps<{
  workspaceId: string
  treeCollapsed?: boolean
  codeOpen?: boolean
  changesOpen?: boolean
}>()

const emit = defineEmits<{
  upload: []
  importSource: []
  settings: []
  addWorkspace: []
  files: []
  toggleTree: []
  toggleCode: []
  toggleChanges: []
}>()

const { t } = useI18n()
const router = useRouter()
const ws = useWorkspaceStore()
const sessionStore = useSessionStore()
const auth = useAuthStore()

const breadcrumb = computed(() => {
  const active = ws.activeFilePath
  if (!active) return [] as Array<{ label: string; path: string; isLast: boolean }>
  return active.split('/').map((part, i, arr) => ({
    label: part,
    path: arr.slice(0, i + 1).join('/'),
    isLast: i === arr.length - 1,
  }))
})

const workspaceLabel = computed(() => {
  const id = props.workspaceId || auth.currentWorkspaceId || ''
  return auth.workspace?.name || (id ? `Workspace ${id.slice(0, 6)}` : 'Workspace')
})

function handleRefresh() {
  ws.refreshTree()
}

function switchToChat() {
  const id = sessionStore.currentSessionId
  if (id) router.push(`/chat/${id}`)
}

function openEnvironment() {
  const id = props.workspaceId || auth.currentWorkspaceId
  if (id) router.push(`/workspace/${id}/environment`)
}

function switchSession(id: string) {
  sessionStore.selectSession(id)
  router.push(`/chat/${id}`)
}
</script>

<template>
  <div class="flex items-center gap-2 px-3 h-10 border-b shrink-0 bg-background/80">
    <button
      class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors md:hidden"
      title="Files"
      aria-label="Files"
      data-testid="workspace-toolbar-files-mobile"
      @click="emit('files')"
    >
      <PanelLeft class="size-3.5" />
    </button>
    <button
      data-testid="workspace-toolbar-changes-mobile"
      class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors md:hidden"
      :title="t('workspace.panelChanges')"
      :aria-label="t('workspace.panelChanges')"
      @click="emit('toggleChanges')"
    >
      <FileDiff class="size-3.5" />
    </button>
    <div class="flex min-w-0 items-center gap-1 pr-12 text-xs text-muted-foreground flex-1" :title="props.workspaceId">
      <FolderTree class="size-3.5" />
      <template v-if="breadcrumb.length > 0">
        <span
          v-for="(part, i) in breadcrumb"
          :key="i"
          class="flex items-center gap-1"
        >
          <span v-if="i > 0" class="text-muted-foreground/50">/</span>
          <span
            class="hover:text-foreground cursor-pointer"
            :class="{ 'text-foreground font-medium': part.isLast }"
          >
            {{ part.label }}
          </span>
        </span>
      </template>
       <span v-else class="truncate text-foreground/80 font-medium">{{ workspaceLabel }}</span>
    </div>

     <div class="flex items-center gap-1 max-md:hidden">
      <button
        type="button"
        data-testid="workspace-toolbar-toggle-tree"
        class="p-1.5 rounded text-muted-foreground transition-colors hover:bg-accent"
        :title="treeCollapsed ? t('workspace.expandFiles') : t('workspace.collapseFiles')"
        :aria-label="treeCollapsed ? t('workspace.expandFiles') : t('workspace.collapseFiles')"
        @click="emit('toggleTree')"
      >
        <FolderTree class="size-3.5" />
      </button>
      <button
        type="button"
        data-testid="workspace-toolbar-code"
        class="p-1.5 rounded transition-colors"
        :class="codeOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent'"
        :title="t('workspace.toggleCode')"
        :aria-label="t('workspace.toggleCode')"
        :aria-pressed="codeOpen === true"
        @click="emit('toggleCode')"
      >
        <Code class="size-3.5" />
      </button>
      <button
        type="button"
        data-testid="workspace-toolbar-changes"
        class="p-1.5 rounded transition-colors"
        :class="changesOpen ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent'"
        :title="t('workspace.toggleDiff')"
        :aria-label="t('workspace.toggleDiff')"
        :aria-pressed="changesOpen === true"
        @click="emit('toggleChanges')"
      >
        <FileDiff class="size-3.5" />
      </button>
      <select
        :value="sessionStore.currentSessionId ?? ''"
        class="text-xs bg-background border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
        @change="switchSession(($event.target as HTMLSelectElement).value)"
      >
                <option value="" disabled>会话</option>
        <option
          v-for="session in sessionStore.sessions"
          :key="session.id"
          :value="session.id"
        >
          {{ session.title }}
        </option>
      </select>
      <button
        class="px-2 py-1 text-xs rounded border hover:bg-accent text-muted-foreground transition-colors"
        title="Switch to chat"
        @click="switchToChat"
      >
         聊天
      </button>
      <button
        data-testid="workspace-toolbar-environment"
        class="px-2 py-1 text-xs rounded border hover:bg-accent text-muted-foreground transition-colors"
        title="View workspace environment"
        @click="openEnvironment"
      >
         环境
      </button>
      <button
        data-testid="workspace-toolbar-settings"
        class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
        title="Workspace settings"
        @click="emit('settings')"
      >
        <Settings2 class="size-3.5" />
      </button>
      <button
        data-testid="workspace-toolbar-add"
        class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
        :title="t('workspace.addWorkspace')"
        :aria-label="t('workspace.addWorkspace')"
        @click="emit('addWorkspace')"
      >
        <Plus class="size-3.5" />
      </button>
      <button
        data-testid="workspace-toolbar-import-source"
        class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
        title="Import workspace directory"
        @click="emit('importSource')"
      >
        <FolderOpen class="size-3.5" />
      </button>
      <button
        class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
        title="Upload files"
        @click="emit('upload')"
      >
        <Upload class="size-3.5" />
      </button>
      <button
        class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
        title="Refresh"
        @click="handleRefresh"
      >
        <RefreshCw class="size-3.5" />
      </button>
    </div>
  </div>
</template>
