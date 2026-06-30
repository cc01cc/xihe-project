<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'
import SessionItem from './SessionItem.vue'

const { t } = useI18n()
const router = useRouter()
const sessionStore = useSessionStore()
const chatStore = useChatStore()

const timeGroupLabels: Record<string, string> = {
  today: 'sidebar.today',
  yesterday: 'sidebar.yesterday',
  earlier: 'sidebar.earlier',
}

function handleSelect(id: string) {
  sessionStore.selectSession(id)
  router.push(`/chat/${id}`)
}

function handleRename(id: string, title: string) {
  sessionStore.renameSession(id, title)
}

function handleDelete(id: string) {
  sessionStore.deleteSession(id)
  chatStore.deleteSession(id)
}
</script>

<template>
  <div class="flex-1 overflow-y-auto px-2 py-2 space-y-1">
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
</template>
