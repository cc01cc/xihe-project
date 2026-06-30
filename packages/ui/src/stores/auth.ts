import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api } from '../composables/api'
import { logger } from '../lib/logger'
import type { User } from '../types'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('xihe-token'))
  const user = ref<User | null>(_loadUser())
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isAuthenticated = computed(() => !!token.value)
  const userName = computed(() => user.value?.name ?? user.value?.email ?? 'User')

  function _loadUser(): User | null {
    try {
      const raw = localStorage.getItem('xihe-user')
      return raw ? JSON.parse(raw) : null
    } catch {
      logger.warn('Failed to parse saved user from localStorage')
      return null
    }
  }

  function _saveToken(t: string, u: User) {
    token.value = t
    user.value = u
    localStorage.setItem('xihe-token', t)
    localStorage.setItem('xihe-user', JSON.stringify(u))
  }

  async function login(email: string, password: string) {
    loading.value = true
    error.value = null
    try {
      const res = await api.login(email, password)
      _saveToken(res.accessToken, res.user)
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Login failed'
      logger.error('Login failed: ' + msg)
      error.value = msg
      return false
    } finally {
      loading.value = false
    }
  }

  async function register(email: string, password: string, name: string) {
    loading.value = true
    error.value = null
    try {
      const res = await api.register(email, password, name)
      _saveToken(res.accessToken, res.user)
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Registration failed'
      logger.error('Registration failed: ' + msg)
      error.value = msg
      return false
    } finally {
      loading.value = false
    }
  }

  function logout() {
    token.value = null
    user.value = null
    error.value = null
    localStorage.removeItem('xihe-token')
    localStorage.removeItem('xihe-user')
  }

  return {
    token, user, loading, error, isAuthenticated, userName,
    login, register, logout,
  }
})
