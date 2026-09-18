<script setup lang="ts">
import { computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'
import { useAuthStore } from '../../stores/auth'
import { ApiError, api } from '../../composables/api'
import { parseRawToParts } from '../../composables/useStreamParser'
import { logger } from '../../lib/logger'
import type { Message, ToolCall } from '../../types'
import ChatPanel from './ChatPanel.vue'

const route = useRoute()
const sessionStore = useSessionStore()
const chatStore = useChatStore()
const auth = useAuthStore()

const routeSessionId = computed(() => {
  const raw = route.params.sessionId as string | undefined
  if (raw && raw !== 'default') return raw
  return ''
})

const currentSessionId = computed(() => routeSessionId.value || sessionStore.currentSessionId || '')

const isStreaming = computed(() => chatStore.isStreaming(currentSessionId.value))
const currentRunState = computed(() => chatStore.getSessionRunState(currentSessionId.value))
// PLAN-0343: run-terminal usage line in the session info header.
const lastUsage = computed(() => chatStore.getSessionLastUsage(currentSessionId.value))

const usageInput = computed(() => lastUsage.value?.inputTokens)
const usageOutput = computed(() => lastUsage.value?.outputTokens)
const usageSource = computed(() => lastUsage.value?.source)
const usageCost = computed(() => {
  const usage = lastUsage.value
  if (!usage) return null
  if (usage.cost == null) {
    return usage.source === 'fallback' ? '—' : '未映射'
  }
  return `$${usage.cost}`
})
const usageCostTitle = computed(() => {
  const usage = lastUsage.value
  if (!usage || usage.cost != null) return ''
  return usage.costNote ?? 'no pricing entry'
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

// PLAN-0344: job 卡片在刷新后的重建源——tool_result 不持久化，只回填
// jobSummary（账本档案投影），续看内容点开时再按 itemId 拉取。
function jobStatusToToolStatus(status: string): ToolCall['status'] {
  if (status === 'running') return 'running'
  if (status === 'succeeded') return 'completed'
  return 'failed'
}

function jobSummariesToToolCalls(
  summaries: NonNullable<Awaited<ReturnType<typeof api.getMessages>>[number]['jobSummary']>,
): ToolCall[] {
  return summaries.map((job) => ({
    id: job.toolCallId ?? job.itemId,
    name: job.toolName ?? 'background_job',
    arguments: '',
    status: jobStatusToToolStatus(job.status),
    startedAt: job.startedAt ?? undefined,
    completedAt: job.endedAt ?? undefined,
    jobSummary: job,
  }))
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
      runId: msg.runId,
      runStatus: msg.runStatus as Message['runStatus'],
      terminalOutcome: msg.terminalOutcome as Message['terminalOutcome'],
      errorCode: msg.errorCode,
      error: msg.error,
      retryable: msg.retryable,
      attachments: msg.attachments?.map((att) => ({
        id: att.fileId,
        fileId: att.fileId,
        name: att.name,
        type: att.type,
        size: att.size,
        url: `/api/v1/files/${att.fileId}`,
        state: 'done' as const,
      })),
      toolCalls: msg.jobSummary?.length
        ? jobSummariesToToolCalls(msg.jobSummary)
        : undefined,
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
      if (ensured) {
        await loadSessionMessages(ensured)
      }
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
      <!-- PLAN-0343: run-terminal usage line (tokens · cost/unmapped · source badge) -->
      <div
        v-if="lastUsage && usageInput !== undefined"
        class="flex items-center gap-2 text-xs text-muted-foreground tabular-nums"
      >
        <span>in {{ usageInput }} · out {{ usageOutput ?? 0 }}</span>
        <span :title="usageCostTitle" :class="lastUsage.cost == null && usageCost !== '—' ? 'text-amber-500' : ''">
          {{ usageCost }}
        </span>
        <span
          v-if="usageSource"
          class="rounded border px-1 py-0.5 text-[10px] leading-none"
          :class="usageSource === 'real' ? 'border-emerald-500/40 text-emerald-600' : 'border-amber-500/40 text-amber-600'"
        >
          {{ usageSource }}
        </span>
      </div>
      <div v-if="isStreaming" class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span class="relative flex size-3">
          <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
          <span class="relative inline-flex rounded-full size-3 bg-primary" />
        </span>
        <span class="tabular-nums">
          {{ currentRunState.status === 'executing' ? 'Executing' : 'Thinking' }}
        </span>
        <span class="animate-bounce">...</span>
      </div>
    </header>

    <ChatPanel v-if="currentSessionId" :session-id="currentSessionId" class="flex-1" />
  </div>
</template>
