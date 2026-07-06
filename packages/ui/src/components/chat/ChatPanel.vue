<script setup lang="ts">
import { computed, ref } from 'vue'
import { useChatStore } from '../../stores/chat'
import { useAgentStore } from '../../stores/agent'
import { api } from '../../composables/api'
import { logger } from '../../lib/logger'
import type { AttachmentFile } from '../../types'
import MessageList from './MessageList.vue'
import InputArea from './InputArea.vue'
import SSEStream from './SSEStream.vue'

const props = defineProps<{
  sessionId: string
}>()

const chatStore = useChatStore()
const agentStore = useAgentStore()

const messages = computed(() => chatStore.getMessages(props.sessionId))
const isStreaming = computed(() => {
  return agentStore.agentState.status === 'thinking' || agentStore.agentState.status === 'executing'
})

const streamComponent = ref<InstanceType<typeof SSEStream> | null>(null)

function handleSend(content: string, attachments?: AttachmentFile[]) {
  const id = props.sessionId
  if (!id) return

  chatStore.addMessage(id, {
    id: crypto.randomUUID(),
    sessionId: id,
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
    attachments,
  })
  agentStore.setStatus('thinking')
  const fileIds = attachments
    ?.map((a) => a.fileId)
    .filter((fileId): fileId is string => fileId !== undefined)
  streamComponent.value?.sendMessage(content, { attachments: fileIds })
}

async function handleDeleteMessage(messageId: string) {
  try {
    await api.deleteMessage(props.sessionId, messageId)
    chatStore.deleteMessage(props.sessionId, messageId)
  } catch (err) {
    logger.error('Failed to delete message', err)
  }
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
</script>

<template>
  <div class="flex flex-col h-full min-h-0 overflow-hidden">
    <MessageList
      v-if="messages.length > 0"
      :messages="messages"
      @approve="approveTool"
      @reject="rejectTool"
      @delete="handleDeleteMessage"
    />

    <div v-else class="flex-1 flex flex-col items-center justify-center gap-4 px-4">
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

    <InputArea
      :session-id="sessionId"
      :is-streaming="isStreaming"
      @send="handleSend"
      @stop="stopStreaming"
    />

    <SSEStream
      :session-id="sessionId"
      :active="true"
      ref="streamComponent"
    />
  </div>
</template>
