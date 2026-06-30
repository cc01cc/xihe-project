import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api } from '../api'

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  localStorage.clear()
  fetchSpy = vi.spyOn(globalThis, 'fetch')
})

afterEach(() => {
  fetchSpy.mockRestore()
})

describe('api.login', () => {
  it('sends POST to /api/v1/auth/login with credentials', async () => {
    const mockResponse = {
      accessToken: 'test-token',
      user: { id: '1', email: 'test@test.com' },
    }
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response)

    const result = await api.login('test@test.com', 'password123')

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'test@test.com', password: 'password123' }),
      }),
    )
    expect(result.accessToken).toBe('test-token')
    expect(result.user.email).toBe('test@test.com')
  })

  it('includes Authorization header when token exists', async () => {
    localStorage.setItem('xihe-token', 'existing-token')
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ accessToken: 't', user: { id: '1', email: 'a@b.com' } }),
    } as Response)

    await api.login('a@b.com', 'pw')

    const callHeaders = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(callHeaders['Authorization']).toBe('Bearer existing-token')
  })

  it('throws on non-ok response', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    } as Response)

    await expect(api.login('bad@test.com', 'wrong')).rejects.toThrow('Session expired')
  })

  it('clears token and redirects to login on 401 for protected paths', async () => {
    localStorage.setItem('xihe-token', 'existing-token')
    localStorage.setItem('xihe-user', '{}')
    // @ts-expect-error jsdom allows location.href assignment
    delete window.location
    // @ts-expect-error redefine for test
    window.location = { href: '/chat', pathname: '/chat' }

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    } as Response)

    await expect(api.getSessions()).rejects.toThrow('Session expired')
    expect(localStorage.getItem('xihe-token')).toBeNull()
    expect(localStorage.getItem('xihe-user')).toBeNull()
    expect(window.location.href).toBe('/login')
  })

  it('does not redirect on 401 when already on public auth pages', async () => {
    localStorage.setItem('xihe-token', 'existing-token')
    // @ts-expect-error jsdom allows location.href assignment
    delete window.location
    // @ts-expect-error redefine for test
    window.location = { href: '/login', pathname: '/login' }

    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    } as Response)

    await expect(api.getSessions()).rejects.toThrow('Session expired')
    expect(window.location.href).toBe('/login')
    expect(localStorage.getItem('xihe-token')).toBeNull()
  })
})

describe('api.register', () => {
  it('sends POST to /api/v1/auth/register with user data', async () => {
    const mockResponse = {
      accessToken: 'reg-token',
      user: { id: '2', email: 'new@test.com' },
    }
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    } as Response)

    const result = await api.register('new@test.com', 'pass', 'New User')

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/auth/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'new@test.com', password: 'pass', name: 'New User' }),
      }),
    )
    expect(result.accessToken).toBe('reg-token')
  })
})

describe('api.getSessions', () => {
  it('sends GET to /api/v1/sessions and returns session list', async () => {
    const mockSessions = {
      sessions: [
        { id: '1', title: 'Chat 1' },
        { id: '2', title: 'Chat 2' },
      ],
    }
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockSessions),
    } as Response)

    const result = await api.getSessions()

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({ headers: expect.any(Object) }),
    )
    expect(result.sessions).toHaveLength(2)
    expect(result.sessions[0].title).toBe('Chat 1')
  })
})

describe('api.createSession', () => {
  it('sends POST to /api/v1/sessions with title', async () => {
    const mockSession = { id: '3', title: 'New Chat' }
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockSession),
    } as Response)

    const result = await api.createSession('New Chat')

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'New Chat' }),
      }),
    )
    expect(result.id).toBe('3')
    expect(result.title).toBe('New Chat')
  })

  it('sends POST without title when omitted', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: '4', title: 'Untitled' }),
    } as Response)

    await api.createSession()

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: undefined }),
      }),
    )
  })
})

describe('api.deleteSession', () => {
  it('sends DELETE to /api/v1/sessions/:id', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response)

    const res = await api.deleteSession('session-123')

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/sessions/session-123',
      { method: 'DELETE' },
    )
    expect(res.status).toBe(204)
  })

  it('does not include Authorization header (direct fetch)', async () => {
    localStorage.setItem('xihe-token', 'some-token')
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as Response)

    await api.deleteSession('s1')

    const callOptions = fetchSpy.mock.calls[0][1] as RequestInit
    expect(callOptions.headers).toBeUndefined()
  })
})

describe('api.getHealth', () => {
  it('sends GET to /api/v1/health and returns status', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: 'UP' }),
    } as Response)

    const result = await api.getHealth()

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/health',
      expect.objectContaining({ headers: expect.any(Object) }),
    )
    expect(result.status).toBe('UP')
  })
})
