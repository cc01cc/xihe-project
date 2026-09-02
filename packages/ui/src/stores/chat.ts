import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Message, MessagePart } from '../types'

export const XIHE_STORAGE_KEYS = ['xihe-token', 'xihe-user', 'xihe-workspace'] as const

export const useChatStore = defineStore('chat', () => {
  // Messages are not business data we should resurrect from localStorage.
  // The server is the canonical source via /api/v1/sessions/{id}/messages,
  // and the session store + chat store are cleared on user switch / logout.
  const messages = ref<Record<string, Message[]>>({})
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

  function loadMessages(sessionId: string, sessionMessages: Message[]) {
    // An in-flight response is owned by the live SSE stream. Do not let a
    // slower history request replace its optimistic user/assistant messages.
    if (isStreaming(sessionId)) return
    messages.value[sessionId] = sessionMessages
  }

  function deleteMessage(sessionId: string, messageId: string) {
    const sessionMessages = messages.value[sessionId]
    if (!sessionMessages) return
    messages.value[sessionId] = sessionMessages.filter((msg) => msg.id !== messageId)
  }

  function addMarker(sessionId: string, marker: Omit<Message, 'id' | 'sessionId'>) {
    addMessage(sessionId, {
      id: crypto.randomUUID(),
      sessionId,
      ...marker,
    })
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

  function appendToParts(sessionId: string, part: MessagePart) {
    const messageId = streamingMessageId.value[sessionId]
    if (!messageId) return

    const msgs = messages.value[sessionId]
    const message = msgs?.find((msg) => msg.id === messageId)
    if (!message) return

    if (!message.parts) {
      message.parts = []
    }

    if (part.type === 'text') {
      const lastText = message.parts.length > 0
        ? message.parts[message.parts.length - 1]
        : null
      if (lastText?.type === 'text') {
        lastText.content += part.content
        return
      }
    }

    if (part.type === 'reasoning') {
      const lastReasoning = message.parts.length > 0
        ? message.parts[message.parts.length - 1]
        : null
      if (lastReasoning?.type === 'reasoning') {
        lastReasoning.content += part.content
        return
      }
    }

    if (part.type === 'artifact') {
      const lastArtifact = message.parts.length > 0
        ? message.parts[message.parts.length - 1]
        : null
      if (lastArtifact?.type === 'artifact' && lastArtifact.identifier === part.identifier) {
        lastArtifact.content += part.content
        return
      }
    }

    message.parts.push(part)
  }

  function replaceStreamingParts(sessionId: string, nextParts: MessagePart[]) {
    const messageId = streamingMessageId.value[sessionId]
    if (!messageId) return

    const message = messages.value[sessionId]?.find((msg) => msg.id === messageId)
    if (!message) return

    message.parts = [...nextParts]
  }

  function finalizeStreaming(sessionId: string) {
    const messageId = streamingMessageId.value[sessionId]
    if (!messageId) {
      return
    }

    const message = messages.value[sessionId]?.find((msg) => msg.id === messageId)
    if (message) {
      message.isStreaming = false
      if (message.parts) {
        message.content = message.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.content)
          .join('')
      }
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

  function clearAllData() {
    for (const key of XIHE_STORAGE_KEYS) {
      try {
        localStorage.removeItem(key)
      } catch {
        // ignore
      }
    }
    messages.value = {}
    streamingMessageId.value = {}
  }

  function clearForUserSwitch() {
    messages.value = {}
    streamingMessageId.value = {}
  }

  return {
    messages,
    streamingMessageId,
    getMessages,
    getStreamingMessageId,
    isStreaming,
    addMessage,
    loadMessages,
    deleteMessage,
    addMarker,
    createStreamingMessage,
    appendToParts,
    replaceStreamingParts,
    finalizeStreaming,
    clearSession,
    deleteSession,
    clearAllData,
    clearForUserSwitch,
  }
})
