import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useStreamParser } from '@/composables/useStreamParser'
import { useChatStore } from '@/stores/chat'

describe('Chat Stream Integration: useStreamParser → store.appendToParts → Message.parts', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  function flushParser(parser: ReturnType<typeof useStreamParser>, store: ReturnType<typeof useChatStore>, sessionId: string, lastSent: { count: number }) {
    const currentParts = parser.parts.value
    for (let i = lastSent.count; i < currentParts.length; i++) {
      store.appendToParts(sessionId, currentParts[i])
    }
    lastSent.count = currentParts.length
  }

  it('text tokens via no-hint accumulate into store via finalize', () => {
    const store = useChatStore()
    const parser = useStreamParser()
    const msgId = store.createStreamingMessage('s1')
    const lastSent = { count: 0 }

    parser.handleToken('Hello')
    flushParser(parser, store, 's1', lastSent)

    parser.handleToken(' world')
    parser.finalize()
    // On finalize, replace store parts with parser state (matching SSEStream.vue pattern)
    const msg = store.getMessages('s1').find(m => m.id === msgId)
    if (msg) {
      msg.parts = [...parser.parts.value]
    }
    store.finalizeStreaming('s1')

    const storedMsg = store.getMessages('s1')[0]
    expect(storedMsg.parts).toHaveLength(1)
    expect(storedMsg.parts![0]).toEqual({ type: 'text', content: 'Hello world' })
    expect(storedMsg.content).toBe('Hello world')
  })

  it('think block via no-hint produces reasoning + text parts', () => {
    const store = useChatStore()
    const parser = useStreamParser()
    store.createStreamingMessage('s1')
    const lastSent = { count: 0 }

    parser.handleToken('Before <think>思考</think> After')
    flushParser(parser, store, 's1', lastSent)
    parser.finalize()

    const msg = store.getMessages('s1')[0]
    expect(msg.parts).toHaveLength(3)
    expect(msg.parts![0]).toEqual({ type: 'text', content: 'Before ' })
    expect(msg.parts![1]).toEqual({ type: 'reasoning', content: '思考' })
    expect(msg.parts![2]).toEqual({ type: 'text', content: ' After' })
  })

  it('hint-reasoning bypasses parser, goes directly to store', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')

    // Match SSEStream.vue pattern: hint-based flow calls appendToParts directly
    store.appendToParts('s1', { type: 'reasoning', content: '思考内容' })
    store.appendToParts('s1', { type: 'text', content: '答案' })

    const msg = store.getMessages('s1')[0]
    expect(msg.parts).toHaveLength(2)
    expect(msg.parts![0]).toEqual({ type: 'reasoning', content: '思考内容' })
    expect(msg.parts![1]).toEqual({ type: 'text', content: '答案' })
  })

  it('finalizeStreaming merges text parts into content', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')

    // Simulate hint-based text flow
    store.appendToParts('s1', { type: 'text', content: 'Hello' })
    store.appendToParts('s1', { type: 'text', content: ' World' })

    store.finalizeStreaming('s1')

    const msg = store.getMessages('s1')[0]
    expect(msg.content).toBe('Hello World')
    expect(msg.isStreaming).toBe(false)
  })
})
