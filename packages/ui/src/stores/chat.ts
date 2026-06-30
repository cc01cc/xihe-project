import { defineStore } from 'pinia'
import { ref, shallowRef, triggerRef } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import type { Message } from '../types'

export const useChatStore = defineStore('chat', () => {
  const messages = useLocalStorage<Record<string, Message[]>>('xihe-messages', {})
  const streamingContent = shallowRef<Record<string, string>>({})
  const streamingSessionId = ref<string | null>(null)

  function getMessages(sessionId: string): Message[] {
    return messages.value[sessionId] ?? []
  }

  function getStreamingContent(sessionId: string): string | undefined {
    return streamingContent.value[sessionId]
  }

  function addMessage(sessionId: string, message: Message) {
    if (!messages.value[sessionId]) {
      messages.value[sessionId] = []
    }
    messages.value[sessionId].push(message)
  }

  function appendToken(sessionId: string, token: string) {
    streamingContent.value[sessionId] = (streamingContent.value[sessionId] ?? '') + token
    streamingSessionId.value = sessionId
    triggerRef(streamingContent)
  }

  function finalizeStreaming(sessionId: string) {
    const content = streamingContent.value[sessionId]
    if (content !== undefined) {
      const msgs = messages.value[sessionId] ?? []
      const lastMsg = msgs[msgs.length - 1]
      if (lastMsg?.role === 'assistant') {
        lastMsg.content = content
      } else {
        addMessage(sessionId, {
          id: crypto.randomUUID(),
          sessionId,
          role: 'assistant',
          content,
          timestamp: new Date().toISOString(),
        })
      }
      delete streamingContent.value[sessionId]
      triggerRef(streamingContent)
      if (streamingSessionId.value === sessionId) {
        streamingSessionId.value = null
      }
    }
  }

  function clearSession(sessionId: string) {
    delete messages.value[sessionId]
    delete streamingContent.value[sessionId]
    triggerRef(streamingContent)
  }

  function deleteSession(sessionId: string) {
    clearSession(sessionId)
  }

  return {
    messages,
    streamingContent,
    streamingSessionId,
    getMessages,
    getStreamingContent,
    addMessage,
    appendToken,
    finalizeStreaming,
    clearSession,
    deleteSession,
  }
})
