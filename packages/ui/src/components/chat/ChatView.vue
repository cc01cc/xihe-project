<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '../../stores/session'
import { useChatStore } from '../../stores/chat'
import { useAgentStore } from '../../stores/agent'
import MessageList from './MessageList.vue'
import InputArea from './InputArea.vue'
import SSEStream from './SSEStream.vue'

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

const messages = computed(() => {
  const id = currentSessionId.value
  if (!id) return []
  return chatStore.getMessages(id)
})

const isStreaming = computed(() => {
  return agentStore.agentState.status === 'thinking' || agentStore.agentState.status === 'executing'
})

const streamComponent = ref<InstanceType<typeof SSEStream> | null>(null)

function handleSend(content: string) {
  const id = currentSessionId.value
  if (!id) return
  chatStore.addMessage(id, {
    id: crypto.randomUUID(),
    sessionId: id,
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
  })
  agentStore.setStatus('thinking')
  streamComponent.value?.sendMessage(content)
}

function approveTool(toolId: string) {
  agentStore.approveTool(toolId)
}

function rejectTool(toolId: string) {
  agentStore.rejectTool(toolId)
}

function stopStreaming() {
  streamComponent.value?.stopStreaming?.()
}

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

    <div v-if="messages.length === 0" class="flex-1 flex flex-col items-center justify-center gap-4 px-4">
      <div class="text-2xl font-semibold text-muted-foreground">xihe</div>
      <p class="text-sm text-muted-foreground text-center max-w-md">你好，我是 xihe Agent。有什么我可以帮你的？</p>
      <div class="flex flex-wrap gap-2 justify-center max-w-md">
        <button
          v-for="suggestion in ['今天天气怎么样？', '帮我写一封邮件', '解释一下这个概念', '总结一下这段代码']"
          :key="suggestion"
          class="px-3 py-1.5 text-xs rounded-full border border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          @click="handleSend(suggestion)"
        >
          {{ suggestion }}
        </button>
      </div>
    </div>

    <MessageList
      v-else
      :messages="messages"
      @approve="approveTool"
      @reject="rejectTool"
    />

    <InputArea
      :is-streaming="isStreaming"
      @send="handleSend"
      @stop="stopStreaming"
    />

    <SSEStream
      v-if="currentSessionId"
      ref="streamComponent"
      :session-id="currentSessionId"
      :active="true"
    />
  </div>
</template>
