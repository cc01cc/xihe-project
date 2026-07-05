<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'
import { useAgentStore } from '../../stores/agent'
import ChatPanel from './ChatPanel.vue'

const route = useRoute()
const sessionStore = useSessionStore()
const chatStore = useChatStore()
const agentStore = useAgentStore()

const currentSessionId = computed(() => {
  const id = (route.params.sessionId as string) || sessionStore.currentSessionId
  if (id && !sessionStore.currentSessionId) {
    sessionStore.selectSession(id)
  }
  return id
})

const isStreaming = computed(() => {
  return agentStore.agentState.status === 'thinking' || agentStore.agentState.status === 'executing'
})

onMounted(() => {
  if (!currentSessionId.value) {
    const session = sessionStore.createSession()
    chatStore.clearSession(session.id)
  }
})
</script>

<template>
  <div class="flex flex-col h-full">
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
