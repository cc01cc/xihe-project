import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import type { Message } from '../types'

export const useChatStore = defineStore('chat', () => {
  const messages = useLocalStorage<Record<string, Message[]>>('xihe-messages', {})
  const streamingMessageId = ref<Record<string, string | null>>({})

  function getMessages(sessionId: string): Message[] {
    return messages.value[sessionId] ?? []
  }

  function getStreamingMessageId(sessionId: string): string | null {
    return streamingMessageId.value[sessionId] ?? null
  }

  function isStreaming(sessionId: string): boolean {
    return streamingMessageId.value[sessionId] !== undefined && streamingMessageId.value[sessionId] !== null
  }

  function addMessage(sessionId: string, message: Message) {
    if (!messages.value[sessionId]) {
      messages.value[sessionId] = []
    }
    messages.value[sessionId].push(message)
  }

  function createStreamingMessage(sessionId: string): string {
    const id = crypto.randomUUID()
    const message: Message = {
      id,
      sessionId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isStreaming: true,
    }
    addMessage(sessionId, message)
    streamingMessageId.value[sessionId] = id
    return id
  }

  function appendToken(sessionId: string, token: string) {
    const messageId = streamingMessageId.value[sessionId]
    if (!messageId) {
      return
    }

    const msgs = messages.value[sessionId]
    const message = msgs?.find((msg) => msg.id === messageId)

    if (message) {
      message.content += token
    }
  }

  function finalizeStreaming(sessionId: string) {
    const messageId = streamingMessageId.value[sessionId]
    if (!messageId) {
      return
    }

    const message = messages.value[sessionId]?.find((msg) => msg.id === messageId)
    if (message) {
      message.isStreaming = false
    }

    streamingMessageId.value[sessionId] = null
  }

  function clearSession(sessionId: string) {
    delete messages.value[sessionId]
    delete streamingMessageId.value[sessionId]
  }

  function deleteSession(sessionId: string) {
    clearSession(sessionId)
  }

  return {
    messages,
    streamingMessageId,
    getMessages,
    getStreamingMessageId,
    isStreaming,
    addMessage,
    createStreamingMessage,
    appendToken,
    finalizeStreaming,
    clearSession,
    deleteSession,
  }
})
