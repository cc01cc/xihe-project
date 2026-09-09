<script setup lang="ts">
import { computed, watch } from 'vue'
import { useSSE, type SSEErrorPayload } from '../../composables/useSSE'
import { useStreamParser } from '../../composables/useStreamParser'
import { useChatStore } from '../../stores/chat'
import { useAgentStore } from '../../stores/agent'
import { useConfigStore } from '../../stores/config'
import { useWorkspaceAgentSync } from '../../composables/useWorkspaceAgentSync'
import { toast } from 'vue-sonner'
import { logger } from '../../lib/logger'
import { chatErrorToastText } from '../../lib/errorMessages'
import { api } from '../../composables/api'
import type { ChatRunResponse } from '../../types'

const props = withDefaults(defineProps<{
  sessionId: string
  active: boolean
  toolMode?: 'none' | 'workspace'
}>(), {
  toolMode: 'none',
})

const chatStore = useChatStore()
const agentStore = useAgentStore()
const configStore = useConfigStore()
const { handleToolCall } = useWorkspaceAgentSync()

const { isConnected, isStreaming, connect, sendMessage, disconnect } = useSSE(
  computed(() => props.sessionId),
)
let activeRunId: string | undefined

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
  let terminalError: SSEErrorPayload | null = null
  connect({
    onStart: () => {
      parser.reset()
      chatStore.createStreamingMessage(id, activeRunId)
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
    onDone: (outcome?: string) => {
      parser.finalize()
      if (parser.parts.value.length > 0) {
        chatStore.replaceStreamingParts(id, parser.parts.value)
      }
      if (outcome === 'error' || outcome === 'partial' || outcome === 'ambiguous') {
        chatStore.markStreamingError(id, terminalError ?? {
          code: outcome === 'ambiguous' ? 'AGENT_STREAM_AMBIGUOUS' : 'AGENT_STREAM_FAILED',
          detail: outcome === 'ambiguous' ? 'The provider result is uncertain; retry requires confirmation' : 'Agent stream failed',
          runId: activeRunId,
          retryable: outcome !== 'ambiguous',
          outcome,
        })
      } else {
        chatStore.finalizeStreaming(id)
      }
      agentStore.setStatus('idle')
    },
    onError: (payload: SSEErrorPayload) => {
      terminalError = payload
      chatStore.markStreamingError(id, payload)
      agentStore.setStatus('error')
      toast.error(chatErrorToastText(payload.code, payload.detail))
    },
    onToolCall: (name: string, args: Record<string, unknown>) => {
      handleToolCall(name, args)
    },
  })
}

async function handleSend(content: string, options?: { attachments?: string[]; toolMode?: 'none' | 'workspace' }): Promise<ChatRunResponse | null> {
  const sessionId = props.sessionId
  if (!sessionId) return null

  if (!isConnected.value) {
    connectSession(sessionId)
    const ready = await waitForConnection(5000)
    if (!ready) {
      const msg = 'SSE connection not established'
      logger.warn(msg)
      agentStore.setStatus('idle')
      toast.error(msg)
      return null
    }
  }

  const binding = configStore.getEffectiveModel(sessionId)
  const model = binding?.model ?? ''
  const result = await sendMessage({
    content,
    model,
    provider: binding?.provider,
    toolMode: options?.toolMode ?? props.toolMode,
    idempotencyKey: crypto.randomUUID(),
    sessionId,
    attachments: options?.attachments,
  })
  if (result) {
    activeRunId = result.runId
    agentStore.setStatus('thinking')
  }
  return result
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
  if (activeRunId) {
    api.cancelChatRun(activeRunId).catch((err) => {
      logger.warn('Failed to cancel chat run:', err)
    })
  }
  disconnect()
  agentStore.setStatus('idle')
}

defineExpose({ sendMessage: handleSend, stopStreaming, isConnected, isStreaming })
</script>

<template>

</template>
