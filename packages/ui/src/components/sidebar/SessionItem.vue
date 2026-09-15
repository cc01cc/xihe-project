<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { CircleAlert, MessageSquareText } from '@lucide/vue'
import type { Session } from '../../types'

const props = withDefaults(defineProps<{
  session: Session
  isActive: boolean
  pendingCount?: number
}>(), {
  pendingCount: 0,
})

const emit = defineEmits<{
  select: [id: string]
  rename: [id: string, title: string]
  delete: [id: string]
}>()

const { t } = useI18n()
const isRenaming = ref(false)
const renameValue = ref('')
const showContextMenu = ref(false)
const contextMenuPosition = ref({ x: 0, y: 0 })

function handleClick() {
  emit('select', props.session.id)
}

function handleKeydown(event: KeyboardEvent) {
  if (isRenaming.value) return
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    handleClick()
  }
}

function handleContextMenu(e: MouseEvent) {
  e.preventDefault()
  contextMenuPosition.value = { x: e.clientX, y: e.clientY }
  showContextMenu.value = true
}

function startRename() {
  renameValue.value = props.session.title
  isRenaming.value = true
  showContextMenu.value = false
}

function confirmRename() {
  if (renameValue.value.trim()) {
    emit('rename', props.session.id, renameValue.value.trim())
  }
  isRenaming.value = false
}

function handleDelete() {
  showContextMenu.value = false
  emit('delete', props.session.id)
}

function handleRenameKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') confirmRename()
  if (e.key === 'Escape') isRenaming.value = false
}
</script>

<template>
  <div
    data-testid="session-item"
    class="group relative flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
    :class="isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50 text-sidebar-foreground'"
    role="button"
    tabindex="0"
    :aria-current="isActive ? 'page' : undefined"
    :aria-label="session.title"
    @click="handleClick"
    @keydown="handleKeydown"
    @contextmenu="handleContextMenu"
  >
    <MessageSquareText class="size-4 shrink-0 opacity-70" />
    <div v-if="isRenaming" class="flex-1 min-w-0">
      <input
        v-model="renameValue"
        class="w-full px-2 py-0.5 text-sm rounded border bg-background"
        autofocus
        @blur="confirmRename"
        @keydown.stop="handleRenameKeydown"
        @click.stop
      />
    </div>
    <span v-else class="flex-1 truncate text-sm">{{ session.title }}</span>
    <span
      v-if="pendingCount > 0"
      data-testid="session-pending-badge"
      class="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-foreground"
      aria-live="polite"
    >
      <CircleAlert class="size-3" aria-hidden="true" />
      <span>{{ t('sidebar.pendingApprovalBadge') }}</span>
      <span class="tabular-nums">{{ pendingCount }}</span>
    </span>
  </div>

  <Teleport to="body">
    <div
      v-if="showContextMenu"
      class="fixed inset-0 z-50"
      @click="showContextMenu = false"
    >
      <div
        class="absolute w-40 py-1 rounded-lg border bg-popover shadow-lg"
        :style="{ left: contextMenuPosition.x + 'px', top: contextMenuPosition.y + 'px' }"
      >
        <button
          class="w-full px-3 py-1.5 text-left text-sm hover:bg-accent transition-colors"
          @click="startRename"
        >
          {{ t('sidebar.rename') }}
        </button>
        <button
          class="w-full px-3 py-1.5 text-left text-sm text-destructive hover:bg-destructive/10 transition-colors"
          @click="handleDelete"
        >
          {{ t('sidebar.delete') }}
        </button>
      </div>
    </div>
  </Teleport>
</template>
