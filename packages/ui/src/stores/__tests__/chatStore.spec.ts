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

  it('createStreamingMessage adds assistant message and tracks it', () => {
    const store = useChatStore()
    const id = store.createStreamingMessage('s1')
    const msgs = store.getMessages('s1')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('assistant')
    expect(msgs[0].id).toBe(id)
    expect(msgs[0].isStreaming).toBe(true)
    expect(store.getStreamingMessageId('s1')).toBe(id)
    expect(store.isStreaming('s1')).toBe(true)
  })

  it('appendToParts appends text parts to streaming message content', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'text', content: 'Hel' })
    store.appendToParts('s1', { type: 'text', content: 'lo' })
    expect(store.getMessages('s1')[0].parts).toHaveLength(1)
    expect(store.getMessages('s1')[0].parts![0]).toEqual({ type: 'text', content: 'Hello' })
  })

  it('appendToParts appends reasoning parts separately', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'reasoning', content: '思考中' })
    store.appendToParts('s1', { type: 'text', content: '答案' })
    const parts = store.getMessages('s1')[0].parts!
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'reasoning', content: '思考中' })
    expect(parts[1]).toEqual({ type: 'text', content: '答案' })
  })

  it('appendToParts merges consecutive same-type parts', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'text', content: 'A' })
    store.appendToParts('s1', { type: 'text', content: 'B' })
    expect(store.getMessages('s1')[0].parts).toHaveLength(1)
    expect(store.getMessages('s1')[0].parts![0].content).toBe('AB')
  })

  it('appendToParts does nothing when no streaming message exists', () => {
    const store = useChatStore()
    store.appendToParts('s1', { type: 'text', content: 'orphan' })
    expect(store.getMessages('s1')).toEqual([])
  })

  it('finalizeStreaming marks streaming message as completed', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'text', content: 'streamed content' })
    store.finalizeStreaming('s1')
    const msgs = store.getMessages('s1')
    expect(msgs[0].content).toBe('streamed content')
    expect(msgs[0].isStreaming).toBe(false)
    expect(store.isStreaming('s1')).toBe(false)
  })

  it('finalizeStreaming merges parts into content', () => {
    const store = useChatStore()
    store.createStreamingMessage('s1')
    store.appendToParts('s1', { type: 'reasoning', content: '思考' })
    store.appendToParts('s1', { type: 'text', content: '答案' })
    store.finalizeStreaming('s1')
    expect(store.getMessages('s1')[0].content).toBe('答案')
  })

  it('finalizeStreaming does nothing when no streaming message exists', () => {
    const store = useChatStore()
    store.finalizeStreaming('s1')
    expect(store.getMessages('s1')).toEqual([])
  })

  it('clearSession removes all data for a session', () => {
    const store = useChatStore()
    store.addMessage('s1', {
      id: 'm1', sessionId: 's1', role: 'user' as const,
      content: 'x', timestamp: '2024-01-01',
    })
    store.createStreamingMessage('s1')
    store.clearSession('s1')
    expect(store.getMessages('s1')).toEqual([])
    expect(store.getStreamingMessageId('s1')).toBeNull()
    expect(store.isStreaming('s1')).toBe(false)
  })

  it('clearAllData clears auth-only localStorage keys and resets in-memory messages', () => {
    localStorage.setItem('xihe-token', 'abc')
    localStorage.setItem('xihe-workspace', JSON.stringify({ id: 'ws-1' }))
    const store = useChatStore()
    store.addMessage('s1', {
      id: 'm1',
      sessionId: 's1',
      role: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
    })
    store.clearAllData()
    expect(localStorage.getItem('xihe-token')).toBeNull()
    expect(localStorage.getItem('xihe-workspace')).toBeNull()
    expect(store.getMessages('s1')).toEqual([])
  })
})
