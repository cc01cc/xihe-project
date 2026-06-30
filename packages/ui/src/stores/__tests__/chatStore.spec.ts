import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from '../chat'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('useChatStore', () => {
  it('getMessages returns empty array for unknown session', () => {
    const store = useChatStore()
    expect(store.getMessages('nonexistent')).toEqual([])
  })

  it('addMessage stores a message for a session', () => {
    const store = useChatStore()
    const msg = {
      id: 'm1', sessionId: 's1', role: 'user' as const,
      content: 'hello', timestamp: new Date().toISOString(),
    }
    store.addMessage('s1', msg)
    expect(store.getMessages('s1')).toHaveLength(1)
    expect(store.getMessages('s1')[0].content).toBe('hello')
  })

  it('addMessage appends to existing messages', () => {
    const store = useChatStore()
    store.addMessage('s1', {
      id: 'm1', sessionId: 's1', role: 'user' as const,
      content: 'first', timestamp: '2024-01-01',
    })
    store.addMessage('s1', {
      id: 'm2', sessionId: 's1', role: 'assistant' as const,
      content: 'second', timestamp: '2024-01-01',
    })
    expect(store.getMessages('s1')).toHaveLength(2)
  })

  it('appendToken accumulates streaming content', () => {
    const store = useChatStore()
    store.appendToken('s1', 'Hel')
    store.appendToken('s1', 'lo')
    expect(store.getStreamingContent('s1')).toBe('Hello')
    expect(store.streamingSessionId).toBe('s1')
  })

  it('finalizeStreaming moves content to last assistant message', () => {
    const store = useChatStore()
    store.addMessage('s1', {
      id: 'm1', sessionId: 's1', role: 'assistant' as const,
      content: '', timestamp: '2024-01-01',
    })
    store.appendToken('s1', 'streamed content')
    store.finalizeStreaming('s1')
    const msgs = store.getMessages('s1')
    expect(msgs[0].content).toBe('streamed content')
    expect(store.getStreamingContent('s1')).toBeUndefined()
  })

  it('finalizeStreaming creates new message when no assistant message exists', () => {
    const store = useChatStore()
    store.appendToken('s1', 'new content')
    store.finalizeStreaming('s1')
    const msgs = store.getMessages('s1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].content).toBe('new content')
  })

  it('clearSession removes all data for a session', () => {
    const store = useChatStore()
    store.addMessage('s1', {
      id: 'm1', sessionId: 's1', role: 'user' as const,
      content: 'x', timestamp: '2024-01-01',
    })
    store.appendToken('s1', 'pending')
    store.clearSession('s1')
    expect(store.getMessages('s1')).toEqual([])
    expect(store.getStreamingContent('s1')).toBeUndefined()
  })
})
