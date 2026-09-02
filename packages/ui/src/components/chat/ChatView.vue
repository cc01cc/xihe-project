<script setup lang="ts">
import { computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'
import { useAgentStore } from '../../stores/agent'
import { useAuthStore } from '../../stores/auth'
import { api, ApiError } from '../../composables/api'
import { parseRawToParts } from '../../composables/useStreamParser'
import { logger } from '../../lib/logger'
import type { Message } from '../../types'
import ChatPanel from './ChatPanel.vue'

const route = useRoute()
const sessionStore = useSessionStore()
const chatStore = useChatStore()
const agentStore = useAgentStore()
const auth = useAuthStore()

const routeSessionId = computed(() => {
  const raw = route.params.sessionId as string | undefined
  if (raw && raw !== 'default') return raw
  return ''
})

const currentSessionId = computed(() => routeSessionId.value || sessionStore.currentSessionId || '')

const isStreaming = computed(() => {
  return agentStore.agentState.status === 'thinking' || agentStore.agentState.status === 'executing'
})

async function ensureSession(): Promise<string | null> {
  const fromRoute = routeSessionId.value
  if (fromRoute) {
    if (!sessionStore.sessions.some((session) => session.id === fromRoute)) {
      try {
        await sessionStore.loadSession(fromRoute)
      } catch (cause) {
        logger.warn('Failed to load session from route', cause)
        return null
      }
    }
    sessionStore.selectSession(fromRoute)
    return fromRoute
  }
  if (!auth.currentWorkspaceId) {
    logger.warn('Missing current workspace, cannot create session')
    return null
  }
  try {
    if (sessionStore.sessions.length === 0) {
      await sessionStore.loadSessions()
    }
    if (sessionStore.sessions.length > 0) {
      const first = sessionStore.sessions[0]
      sessionStore.selectSession(first.id)
      return first.id
    }
    const created = await sessionStore.createSession()
    return created.id
  } catch (cause) {
    logger.warn('Create session failed', cause)
    return null
  }
}

async function loadSessionMessages(sessionId: string) {
  try {
    const rawMessages = await api.getMessages(sessionId)
    if (!Array.isArray(rawMessages)) {
      logger.debug('Messages response is not an array, ignoring')
      return
    }
    const normalized: Message[] = rawMessages.map((msg) => ({
      id: msg.id,
      sessionId: msg.sessionId,
      role: msg.role.toLowerCase() as 'user' | 'assistant' | 'system',
      content: msg.content,
      parts: msg.role.toLowerCase() === 'assistant' ? parseRawToParts(msg.content) : undefined,
      timestamp: msg.createdAt,
      attachments: msg.attachments?.map((att) => ({
        id: att.fileId,
        fileId: att.fileId,
        name: att.name,
        type: att.type,
        size: att.size,
        url: `/api/v1/files/${att.fileId}`,
        state: 'done' as const,
      })),
    }))
    chatStore.loadMessages(sessionId, normalized)
  } catch (err) {
    if (err instanceof ApiError && err.problem.code === 'MESSAGE_NOT_FOUND') {
      logger.debug('Session has no persisted messages yet', err)
      return
    }
    logger.error('Failed to load session messages', err)
  }
}

watch(
  currentSessionId,
  async (id) => {
    if (!id) {
      const ensured = await ensureSession()
      if (ensured) await loadSessionMessages(ensured)
      return
    }
    sessionStore.selectSession(id)
    await loadSessionMessages(id)
  },
  { immediate: true },
)

onMounted(async () => {
  if (!sessionStore.sessions.length) {
    try {
      await sessionStore.loadSessions()
    } catch (cause) {
      logger.debug('Background session load failed', cause)
    }
  }
})
</script>

<template>
  <div class="flex h-full min-w-0 flex-col">
    <header class="flex items-center justify-between px-4 h-12 border-b shrink-0 bg-background/80 backdrop-blur-sm">
      <h2 class="text-sm font-medium truncate">
        {{ sessionStore.currentSession?.title || 'xihe' }}
      </h2>
      <div class="flex items-center gap-2">
        <div v-if="isStreaming" class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span class="relative flex size-3">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span class="relative inline-flex rounded-full size-3 bg-primary" />
          </span>
          <span class="tabular-nums">
            {{ agentStore.agentState.status === 'executing' ? 'Executing' : 'Thinking' }}
          </span>
          <span class="animate-bounce">...</span>
        </div>
      </div>
    </header>

    <ChatPanel v-if="currentSessionId" :session-id="currentSessionId" class="flex-1" />
  </div>
</template>
