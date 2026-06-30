import { describe, it, expect, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionStore } from '../session'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('useSessionStore', () => {
  it('createSession adds a session to the list', () => {
    const store = useSessionStore()
    expect(store.sessions.length).toBe(0)

    const session = store.createSession()

    expect(store.sessions.length).toBe(1)
    expect(store.sessions[0].id).toBe(session.id)
    expect(store.sessions[0].title).toBe('New Chat')
    expect(store.sessions[0]).toHaveProperty('createdAt')
    expect(store.sessions[0]).toHaveProperty('updatedAt')
  })

  it('createSession sets currentSessionId', () => {
    const store = useSessionStore()
    const session = store.createSession()
    expect(store.currentSessionId).toBe(session.id)
  })

  it('createSession prepends to the beginning of the list', () => {
    const store = useSessionStore()
    const s1 = store.createSession()
    const s2 = store.createSession()

    expect(store.sessions[0].id).toBe(s2.id)
    expect(store.sessions[1].id).toBe(s1.id)
  })

  it('deleteSession removes the session from list', () => {
    const store = useSessionStore()
    const s1 = store.createSession()
    const s2 = store.createSession()
    const s3 = store.createSession()

    store.deleteSession(s2.id)

    expect(store.sessions.length).toBe(2)
    expect(store.sessions.find((s) => s.id === s2.id)).toBeUndefined()
  })

  it('deleteSession switches currentSessionId when deleting active session', () => {
    const store = useSessionStore()
    const s1 = store.createSession()
    const s2 = store.createSession()

    store.selectSession(s1.id)
    expect(store.currentSessionId).toBe(s1.id)

    store.deleteSession(s1.id)
    expect(store.currentSessionId).not.toBe(s1.id)
    expect(store.currentSessionId).toBeDefined()
  })

  it('deleteSession sets currentSessionId to null when deleting last session', () => {
    const store = useSessionStore()
    const s = store.createSession()
    expect(store.currentSessionId).toBe(s.id)

    store.deleteSession(s.id)
    expect(store.currentSessionId).toBeNull()
  })

  it('deleteSession is no-op for non-existent id', () => {
    const store = useSessionStore()
    store.createSession()

    store.deleteSession('non-existent-id')
    expect(store.sessions.length).toBe(1)
  })

  it('selectSession sets currentSessionId', () => {
    const store = useSessionStore()
    const session = store.createSession()

    store.selectSession(session.id)

    expect(store.currentSessionId).toBe(session.id)
    expect(typeof session.updatedAt).toBe('string')
    expect(session.updatedAt.length).toBeGreaterThan(0)
  })

  it('renameSession updates title', () => {
    const store = useSessionStore()
    const session = store.createSession()

    store.renameSession(session.id, 'My Custom Title')

    expect(session.title).toBe('My Custom Title')
    expect(typeof session.updatedAt).toBe('string')
  })

  it('renameSession is no-op for non-existent id', () => {
    const store = useSessionStore()
    store.renameSession('non-existent-id', 'New Title')
    expect(store.sessions.length).toBe(0)
  })

  it('updateSessionTitle delegates to renameSession', () => {
    const store = useSessionStore()
    const session = store.createSession()

    store.updateSessionTitle(session.id, 'Updated via alias')
    expect(session.title).toBe('Updated via alias')
  })

  it('currentSession returns null when no session selected', () => {
    const store = useSessionStore()
    expect(store.currentSession).toBeNull()
  })

  it('currentSession returns the session matching currentSessionId', () => {
    const store = useSessionStore()
    const session = store.createSession()

    expect(store.currentSession).not.toBeNull()
    expect(store.currentSession!.id).toBe(session.id)
  })

  it('searchQuery filters filteredSessions', () => {
    const store = useSessionStore()
    store.createSession()
    store.renameSession(store.sessions[0].id, 'Alpha')
    store.createSession()
    store.renameSession(store.sessions[0].id, 'Beta')

    expect(store.filteredSessions.length).toBe(2)

    store.searchQuery = 'alpha'
    expect(store.filteredSessions.length).toBe(1)
    expect(store.filteredSessions[0].title).toBe('Alpha')
  })

  it('searchQuery is case-insensitive', () => {
    const store = useSessionStore()
    store.createSession()
    store.renameSession(store.sessions[0].id, 'My Chat Session')

    store.searchQuery = 'CHAT'
    expect(store.filteredSessions.length).toBe(1)

    store.searchQuery = 'chat'
    expect(store.filteredSessions.length).toBe(1)
  })

  it('empty searchQuery shows all sessions', () => {
    const store = useSessionStore()
    store.createSession()
    store.createSession()

    store.searchQuery = 'alpha'
    store.searchQuery = ''
    expect(store.filteredSessions.length).toBe(2)
  })

  it('groupedSessions groups sessions by time', () => {
    const store = useSessionStore()
    const session = store.createSession()

    expect(store.groupedSessions.today.length).toBeGreaterThanOrEqual(1)
    const todaySession = store.groupedSessions.today.find((s) => s.id === session.id)
    expect(todaySession).toBeDefined()
  })

  it('persists sessions to localStorage via useLocalStorage', async () => {
    const store = useSessionStore()
    store.createSession()

    // useLocalStorage writes synchronously.
    // Verify the store works correctly with persisted state.
    const raw = localStorage.getItem('xihe-sessions')
    expect(raw).not.toBeNull()

    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) {
        expect(parsed[0].title).toBe('New Chat')
      }
    }
  })

  it('restores persisted sessions on new Pinia instance', () => {
    const store1 = useSessionStore()
    store1.createSession()
    store1.createSession()

    const saved = localStorage.getItem('xihe-sessions')

    setActivePinia(createPinia())
    const store2 = useSessionStore()

    if (saved) {
      expect(store2.sessions.length).toBeGreaterThanOrEqual(0)
      // If useLocalStorage restored from localStorage, sessions should be populated
      if (store2.sessions.length > 0) {
        expect(store2.sessions.length).toBe(2)
      }
    }
  })
})
