import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from '../auth'
import type { User } from '../../types'

vi.mock('../../composables/api', () => ({
  api: {
    login: vi.fn(),
    register: vi.fn(),
  },
}))

const mockUser: User = { id: 'u1', email: 'test@test.com', name: 'Test' }

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
})

describe('useAuthStore', () => {
  it('starts unauthenticated', () => {
    const store = useAuthStore()
    expect(store.isAuthenticated).toBe(false)
    expect(store.token).toBeNull()
    expect(store.user).toBeNull()
  })

  it('restores token and user from localStorage', () => {
    localStorage.setItem('xihe-token', 'saved-token')
    localStorage.setItem('xihe-user', JSON.stringify(mockUser))
    const store = useAuthStore()
    expect(store.isAuthenticated).toBe(true)
    expect(store.token).toBe('saved-token')
    expect(store.user?.email).toBe('test@test.com')
  })

  it('login success saves token and user', async () => {
    const { api } = await import('../../composables/api')
    vi.mocked(api.login).mockResolvedValue({
      accessToken: 'new-token',
      user: mockUser,
    })
    const store = useAuthStore()
    const ok = await store.login('test@test.com', 'pass')
    expect(ok).toBe(true)
    expect(store.isAuthenticated).toBe(true)
    expect(store.token).toBe('new-token')
    expect(localStorage.getItem('xihe-token')).toBe('new-token')
  })

  it('login failure sets error and returns false', async () => {
    const { api } = await import('../../composables/api')
    vi.mocked(api.login).mockRejectedValue(new Error('Invalid credentials'))
    const store = useAuthStore()
    const ok = await store.login('bad@test.com', 'wrong')
    expect(ok).toBe(false)
    expect(store.isAuthenticated).toBe(false)
    expect(store.error).toBe('Invalid credentials')
  })

  it('register success saves token and user', async () => {
    const { api } = await import('../../composables/api')
    vi.mocked(api.register).mockResolvedValue({
      accessToken: 'reg-token',
      user: mockUser,
    })
    const store = useAuthStore()
    const ok = await store.register('new@test.com', 'pass', 'New')
    expect(ok).toBe(true)
    expect(store.token).toBe('reg-token')
  })

  it('logout clears all state', () => {
    localStorage.setItem('xihe-token', 't')
    localStorage.setItem('xihe-user', JSON.stringify(mockUser))
    const store = useAuthStore()

    store.logout()

    expect(store.token).toBeNull()
    expect(store.user).toBeNull()
    expect(store.error).toBeNull()
    expect(localStorage.getItem('xihe-token')).toBeNull()
    expect(localStorage.getItem('xihe-user')).toBeNull()
  })

  it('userName falls back to email when name is missing', () => {
    const store = useAuthStore()
    store.$patch({ user: { id: 'u2', email: 'no-name@test.com' } as User })
    expect(store.userName).toBe('no-name@test.com')
  })
})
