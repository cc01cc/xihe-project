import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionStore } from '../session'
import { useAuthStore } from '../auth'

const originalFetch = globalThis.fetch

function mockAuth(workspaceId = 'ws-test') {
  const auth = useAuthStore()
  auth.$patch({
    token: 'mock-token',
    user: { id: 'u-1', email: 'tester@xihe.local' },
    workspace: { id: workspaceId, name: 'Default Workspace' },
  })
  return auth
}

function mockSessionResponse(record: { id: string; title?: string; createdAt?: string; updatedAt?: string }) {
  return {
    id: record.id,
    title: record.title ?? 'New Chat',
    workspaceId: 'ws-test',
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: record.updatedAt ?? new Date().toISOString(),
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('useSessionStore (server canonical)', () => {
  it('createSession POSTs to /sessions and stores the server response', async () => {
    mockAuth()
    const store = useSessionStore()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve(mockSessionResponse({ id: 'remote-1', title: 'Plan' })),
      } as Response)

    const session = await store.createSession('Plan')

    expect(session.id).toBe('remote-1')
    expect(session.title).toBe('Plan')
    expect(store.sessions.length).toBe(1)
    expect(store.sessions[0].id).toBe('remote-1')
    expect(store.currentSessionId).toBe('remote-1')
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({ method: 'POST' }),
    )

    fetchSpy.mockRestore()
  })

  it('createSession prepends to the beginning of the list', async () => {
    mockAuth()
    const store = useSessionStore()
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve(mockSessionResponse({ id: 's2' })),
      } as Response)
    const s1 = await store.createSession('First')
    spy.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(mockSessionResponse({ id: 's3' })),
    } as Response)
    await store.createSession('Second')

    expect(store.sessions[0].id).toBe('s3')
    expect(store.sessions[1].id).toBe(s1.id)
    spy.mockRestore()
  })

  it('deleteSession calls DELETE and removes the row from list', async () => {
    mockAuth()
    const store = useSessionStore()
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve(mockSessionResponse({ id: 's1' })) } as Response)
    const s1 = await store.createSession('S1')
    spy.mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve(mockSessionResponse({ id: 's2' })) } as Response)
    const s2 = await store.createSession('S2')
    spy.mockReset()
    spy.mockResolvedValueOnce({ ok: true, status: 204 } as Response)

    await store.deleteSession(s2.id)

    expect(store.sessions.length).toBe(1)
    expect(store.sessions.find((s) => s.id === s2.id)).toBeUndefined()
    expect(spy).toHaveBeenCalledWith(
      `/api/v1/sessions/${s2.id}`,
      expect.objectContaining({ method: 'DELETE' }),
    )
    spy.mockRestore()
  })

  it('selectSession sets currentSessionId and does not call server', () => {
    mockAuth()
    const store = useSessionStore()
    const spy = vi.spyOn(globalThis, 'fetch')

    store.sessions.push({
      id: 's-1',
      title: 'Sample',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never)
    store.selectSession('s-1')

    expect(store.currentSessionId).toBe('s-1')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('renameSession calls PATCH and refreshes the row', async () => {
    mockAuth()
    const store = useSessionStore()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockSessionResponse({ id: 's1', title: 'Renamed' })),
      } as Response)

    await store.updateSession('s1', { title: 'Renamed' })

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions/s1',
      expect.objectContaining({ method: 'PATCH' }),
    )
    expect(store.sessions[0]?.title).toBe('Renamed')
    fetchSpy.mockRestore()
  })

  it('groupedSessions groups sessions by time', async () => {
    mockAuth()
    const store = useSessionStore()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve(mockSessionResponse({ id: 's1' })),
      } as Response)
    await store.createSession('Group me')
    fetchSpy.mockRestore()

    expect(store.groupedSessions.today.length).toBeGreaterThanOrEqual(1)
    expect(store.groupedSessions.today.some((s) => s.id === 's1')).toBe(true)
  })

  it('searchQuery filters sessions by title', async () => {
    mockAuth()
    const store = useSessionStore()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve(mockSessionResponse({ id: 'a1', title: 'Alpha' })),
      } as Response)
    await store.createSession('Alpha')
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve(mockSessionResponse({ id: 'b1', title: 'Beta' })),
    } as Response)
    await store.createSession('Beta')
    fetchSpy.mockRestore()

    store.searchQuery = 'alpha'
    expect(store.filteredSessions.length).toBe(1)
    expect(store.filteredSessions[0].title).toBe('Alpha')
  })

  it('loadSessions replaces list with server response', async () => {
    mockAuth()
    const store = useSessionStore()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            sessions: [mockSessionResponse({ id: 'srv-1', title: 'Server' })],
            workspace: { id: 'ws-test', name: 'Default Workspace' },
          }),
      } as Response)

    await store.loadSessions()

    expect(store.sessions.length).toBe(1)
    expect(store.sessions[0].id).toBe('srv-1')
    fetchSpy.mockRestore()
  })

  it('resetForUserSwitch clears sessions and currentSessionId', async () => {
    mockAuth()
    const store = useSessionStore()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve(mockSessionResponse({ id: 'temp' })),
      } as Response)
    await store.createSession('Temp')
    fetchSpy.mockRestore()

    store.resetForUserSwitch()

    expect(store.sessions.length).toBe(0)
    expect(store.currentSessionId).toBeNull()
  })

  it('does not persist sessions to localStorage', async () => {
    mockAuth()
    const store = useSessionStore()
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve(mockSessionResponse({ id: 'no-persist' })),
      } as Response)
    await store.createSession('No persist')
    fetchSpy.mockRestore()

    expect(localStorage.getItem('xihe-sessions')).toBeNull()
  })
})

afterEach(() => {
  globalThis.fetch = originalFetch
})
