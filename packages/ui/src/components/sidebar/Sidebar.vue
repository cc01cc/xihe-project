<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  CircleUser,
  FolderTree,
  LogOut,
  PanelLeftClose,
  Plus,
  Search,
  Settings,
} from '@lucide/vue'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'
import { useAuthStore } from '../../stores/auth'
import SessionList from './SessionList.vue'

const props = defineProps<{
  open: boolean
  width: number
  isMobile: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:width': [value: number]
}>()

const router = useRouter()
const { t } = useI18n()
const sessionStore = useSessionStore()
const chatStore = useChatStore()
const auth = useAuthStore()

const sidebarStyle = computed(() => ({
  width: props.open ? `min(${props.width}px, calc(100vw - 1rem))` : '0px',
}))

function startNewChat() {
  const session = sessionStore.createSession()
  chatStore.clearSession(session.id)
  router.push(`/chat/${session.id}`)
}

function toggleSidebar() {
  emit('update:open', !props.open)
}

function handleResizeStart(e: MouseEvent) {
  e.preventDefault()
  const startX = e.clientX
  const startWidth = props.width

  function onMouseMove(ev: MouseEvent) {
    const newWidth = Math.min(360, Math.max(220, startWidth + (ev.clientX - startX)))
    emit('update:width', newWidth)
  }

  function onMouseUp() {
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
  }

  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('mouseup', onMouseUp)
}

function navigateToWorkspace() {
  const id = sessionStore.currentSessionId ?? sessionStore.createSession().id
  router.push(`/workspace/${id}`)
}

function navigateSettings() {
  router.push('/settings/config')
}

function handleLogout() {
  auth.logout()
  router.push('/login')
}
</script>

<template>
  <aside
    data-testid="sidebar"
    :aria-hidden="!open"
    :inert="!open"
    class="fixed left-0 top-0 z-40 flex h-full flex-col overflow-hidden bg-sidebar-background border-r border-sidebar-border transition-[width] duration-300"
    :class="{ 'shadow-lg': isMobile && open }"
    :style="sidebarStyle"
  >
    <div class="flex items-center justify-between px-4 h-14 shrink-0">
      <span class="font-semibold text-sidebar-foreground">xihe</span>
      <button
        type="button"
        aria-label="Close navigation"
        title="Close navigation"
        class="p-1.5 rounded-md hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
        @click="toggleSidebar"
      >
        <PanelLeftClose class="size-4" />
      </button>
    </div>

    <div class="px-3 pb-2">
      <button
        class="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-dashed border-sidebar-border text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        @click="startNewChat"
      >
        <Plus class="size-4" />
        {{ t('sidebar.newChat') }}
      </button>
    </div>

    <div class="px-3 pb-2">
      <div class="relative">
        <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <input
          v-model="sessionStore.searchQuery"
          class="w-full pl-8 pr-3 py-1.5 text-sm rounded-md border bg-sidebar-accent/50 placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-sidebar-ring"
          :placeholder="t('sidebar.search')"
        />
      </div>
    </div>

    <SessionList />

    <div class="px-3 py-2">
      <button
        class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        @click="navigateToWorkspace"
      >
        <FolderTree class="size-4" />
        {{ t('sidebar.workspace') }}
      </button>
    </div>

    <div class="px-3 py-3 border-t border-sidebar-border space-y-1">
      <div class="flex items-center gap-2 px-3 py-2 text-sm text-sidebar-foreground/70">
        <CircleUser class="size-4" />
        <span class="truncate">{{ auth.userName }}</span>
      </div>
      <button
        class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        @click="navigateSettings"
      >
        <Settings class="size-4" />
        {{ t('sidebar.settings') }}
      </button>
      <button
        class="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
        @click="handleLogout"
      >
        <LogOut class="size-4" />
        {{ t('sidebar.logout') }}
      </button>
    </div>

    <div
      v-if="open"
      class="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary/20 transition-colors"
      @mousedown="handleResizeStart"
    />
  </aside>

  <Teleport to="body">
    <div
      v-if="isMobile && open"
      class="fixed inset-0 z-30 bg-black/50"
      @click="emit('update:open', false)"
    />
  </Teleport>
</template>
