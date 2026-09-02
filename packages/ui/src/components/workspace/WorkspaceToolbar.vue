<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useWorkspaceStore } from '../../stores/workspace'
import { useSessionStore } from '../../stores/session'
import { useAuthStore } from '../../stores/auth'

const props = defineProps<{
  workspaceId: string
}>()

const emit = defineEmits<{
  upload: []
}>()

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
  return id ? `WS ${id.slice(0, 6)}` : 'Workspace'
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
    <div class="flex items-center gap-1 text-xs text-muted-foreground flex-1">
      <span class="i-lucide-folder-tree size-3.5" />
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
      <span v-else class="text-muted-foreground/60">{{ workspaceLabel }}</span>
    </div>

    <div class="flex items-center gap-1">
      <select
        :value="sessionStore.currentSessionId ?? ''"
        class="text-xs bg-background border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
        @change="switchSession(($event.target as HTMLSelectElement).value)"
      >
        <option value="" disabled>Session</option>
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
        Chat
      </button>
      <button
        data-testid="workspace-toolbar-environment"
        class="px-2 py-1 text-xs rounded border hover:bg-accent text-muted-foreground transition-colors"
        title="View workspace environment"
        @click="openEnvironment"
      >
        Environment
      </button>
      <button
        class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
        title="Upload files"
        @click="emit('upload')"
      >
        <span class="i-lucide-upload size-3.5" />
      </button>
      <button
        class="p-1.5 rounded hover:bg-accent text-muted-foreground transition-colors"
        title="Refresh"
        @click="handleRefresh"
      >
        <span class="i-lucide-refresh-cw size-3.5" />
      </button>
    </div>
  </div>
</template>
