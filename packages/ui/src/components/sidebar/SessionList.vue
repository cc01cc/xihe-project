<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'
import { useAgentStore } from '../../stores/agent'
import { useAuthStore } from '../../stores/auth'
import { ApiError } from '../../composables/api'
import { logger } from '../../lib/logger'
import { toast } from 'vue-sonner'
import SessionItem from './SessionItem.vue'
import { workspaceChatPath } from '../../lib/routes'
import BaseModal from '../shared/BaseModal.vue'

const { t } = useI18n()
const router = useRouter()
const sessionStore = useSessionStore()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const auth = useAuthStore()
const pendingDeleteSessionId = ref<string | null>(null)
const deleteLoading = ref(false)
const pendingDeleteSession = computed(() =>
  sessionStore.sessions.find((session) => session.id === pendingDeleteSessionId.value) ?? null,
)

const timeGroupLabels: Record<string, string> = {
  today: 'sidebar.today',
  yesterday: 'sidebar.yesterday',
  earlier: 'sidebar.earlier',
}

function handleSelect(id: string) {
  sessionStore.selectSession(id)
  const session = sessionStore.sessions.find((item) => item.id === id)
  const workspaceId = session?.workspaceId ?? auth.currentWorkspaceId
  if (workspaceId) router.push(workspaceChatPath(workspaceId, id))
}

function handleRename(id: string, title: string) {
  sessionStore.renameSession(id, title).catch((cause) => {
    const message = cause instanceof ApiError ? cause.message : 'Failed to rename session'
    logger.error('Rename session failed', cause)
    toast.error(message)
  })
}

function handleDelete(id: string) {
  pendingDeleteSessionId.value = id
}

function closeDeleteWarning() {
  if (!deleteLoading.value) pendingDeleteSessionId.value = null
}

async function confirmDelete() {
  const session = pendingDeleteSession.value
  if (!session || deleteLoading.value) return
  deleteLoading.value = true
  const id = session.id
  try {
    await sessionStore.deleteSession(id)
    chatStore.clearSession(id)
    pendingDeleteSessionId.value = null
  } catch (cause) {
    const message = cause instanceof ApiError ? cause.message : t('sidebar.deleteFailed')
    logger.error('Delete session failed', cause)
    toast.error(message)
  } finally {
    deleteLoading.value = false
  }
}

</script>

<template>
  <div data-testid="sidebar-session-list" class="flex-1 overflow-y-auto px-2 py-2 space-y-1">
    <div v-for="(sessions, group) in sessionStore.groupedSessions" :key="group">
      <div v-if="sessions.length" class="px-1 py-2">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {{ t(timeGroupLabels[group]) }}
        </span>
      </div>
      <SessionItem
        v-for="session in sessions"
        :key="session.id"
        :session="session"
        :is-active="session.id === sessionStore.currentSessionId"
        :pending-count="agentStore.pendingApprovalCount(session.id)"
        @select="handleSelect"
        @rename="handleRename"
        @delete="handleDelete"
      />
    </div>
    <div
      v-if="sessionStore.filteredSessions.length === 0"
      class="px-3 py-8 text-center text-sm text-muted-foreground"
    >
      {{ t('sidebar.empty') }}
    </div>
  </div>

  <BaseModal :show="pendingDeleteSession !== null" @close="closeDeleteWarning">
    <div
      v-if="pendingDeleteSession"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-delete-title"
      aria-describedby="session-delete-child-warning"
      data-testid="session-delete-warning"
    >
      <h2 id="session-delete-title" class="text-base font-semibold">{{ t('sidebar.deleteConfirmTitle') }}</h2>
      <p class="mt-2 text-sm text-muted-foreground" id="session-delete-child-warning">
        {{ t('sidebar.deleteChildWarning') }}
      </p>
      <p class="mt-3 truncate rounded-md bg-muted/50 px-2 py-1 text-sm text-foreground">
        {{ pendingDeleteSession.title }}
      </p>
      <div class="mt-5 flex justify-end gap-2">
        <button
          type="button"
          class="rounded-md border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          :disabled="deleteLoading"
          data-testid="session-delete-cancel"
          @click="closeDeleteWarning"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90 disabled:opacity-50"
          :disabled="deleteLoading"
          data-testid="session-delete-confirm"
          @click="confirmDelete"
        >
          {{ deleteLoading ? t('sidebar.deletePending') : t('sidebar.delete') }}
        </button>
      </div>
    </div>
  </BaseModal>
</template>
