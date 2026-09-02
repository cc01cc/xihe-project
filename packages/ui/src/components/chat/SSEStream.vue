<script setup lang="ts">
import { computed, watch } from 'vue'
import { useSSE } from '../../composables/useSSE'
import { useStreamParser } from '../../composables/useStreamParser'
import { useChatStore } from '../../stores/chat'
import { useAgentStore } from '../../stores/agent'
import { useConfigStore } from '../../stores/config'
import { useWorkspaceAgentSync } from '../../composables/useWorkspaceAgentSync'
import { toast } from 'vue-sonner'
import { logger } from '../../lib/logger'

const props = defineProps<{
  sessionId: string
  active: boolean
}>()

const chatStore = useChatStore()
const agentStore = useAgentStore()
const configStore = useConfigStore()
const { handleToolCall } = useWorkspaceAgentSync()

const { isConnected, isStreaming, connect, sendMessage, disconnect } = useSSE(
  computed(() => props.sessionId),
)

watch(
  () => props.sessionId,
  (id) => {
    if (id) {
      connectSession(id)
    }
  },
  { immediate: true },
)

function connectSession(id: string) {
  const parser = useStreamParser()
  connect({
    onStart: () => {
      parser.reset()
      chatStore.createStreamingMessage(id)
    },
    onToken: (token: string, hint?) => {
      if (hint === 'reasoning') {
        chatStore.appendToParts(id, { type: 'reasoning', content: token })
        return
      }
      if (hint === 'text') {
        chatStore.appendToParts(id, { type: 'text', content: token })
        return
      }
      parser.handleToken(token, hint)
      chatStore.replaceStreamingParts(id, parser.parts.value)
    },
    onStatus: (status: string) => {
      agentStore.setStatus(status as 'thinking' | 'executing' | 'idle')
      if (status === 'thinking' || status === 'executing') {
        chatStore.addMarker(id, {
          role: 'system',
          content: status,
          timestamp: new Date().toISOString(),
          marker: 'status',
          status,
        })
      }
    },
    onDone: () => {
      parser.finalize()
      if (parser.parts.value.length > 0) {
        chatStore.replaceStreamingParts(id, parser.parts.value)
      }
      chatStore.finalizeStreaming(id)
      agentStore.setStatus('idle')
    },
    onError: (msg: string) => {
      chatStore.finalizeStreaming(id)
      agentStore.setStatus('error')
      toast.error(msg)
    },
    onToolCall: (name: string, args: Record<string, unknown>) => {
      handleToolCall(name, args)
    },
  })
}

async function handleSend(content: string, options?: { attachments?: string[] }) {
  const sessionId = props.sessionId
  if (!sessionId) return

  if (!isConnected.value) {
    connectSession(sessionId)
    const ready = await waitForConnection(5000)
    if (!ready) {
      const msg = 'SSE connection not established'
      logger.warn(msg)
      agentStore.setStatus('idle')
      toast.error(msg)
      return
    }
  }

  const binding = configStore.getEffectiveModel(sessionId)
  const model = binding?.model ?? ''
  await sendMessage({ content, model, sessionId, attachments: options?.attachments })
}

function waitForConnection(timeoutMs: number): Promise<boolean> {
  if (isConnected.value) return Promise.resolve(true)
  return new Promise((resolve) => {
    const start = Date.now()
    const check = () => {
      if (isConnected.value) return resolve(true)
      if (Date.now() - start > timeoutMs) return resolve(false)
      setTimeout(check, 100)
    }
    check()
  })
}

function stopStreaming() {
  disconnect()
  agentStore.setStatus('idle')
}

defineExpose({ sendMessage: handleSend, stopStreaming, isConnected, isStreaming })
</script>

<template>

</template>
