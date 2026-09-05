import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, type ApiWorkspace } from '../composables/api'
import { logger } from '../lib/logger'
import { useSessionStore } from './session'
import { useChatStore } from './chat'
import { useConfigStore } from './config'
import type { User } from '../types'

export const useAuthStore = defineStore('auth', () => {
  // Authentication is the only state worth caching. Server is the canonical
  // source for workspace/session/messages; we never write business fields
  // (workspaceId, sessions, messages) to localStorage.
  function readUser(): User | null {
    try {
      const raw = localStorage.getItem('xihe-user')
      return raw ? JSON.parse(raw) : null
    } catch {
      logger.warn('Failed to parse saved user from localStorage')
      return null
    }
  }
  function readWorkspace(): ApiWorkspace | null {
    try {
      const raw = localStorage.getItem('xihe-workspace')
      return raw ? JSON.parse(raw) : null
    } catch {
      logger.warn('Failed to parse saved workspace from localStorage')
      return null
    }
  }

  const token = ref<string | null>(localStorage.getItem('xihe-token'))
  const user = ref<User | null>(readUser())
  const workspace = ref<ApiWorkspace | null>(readWorkspace())
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isAuthenticated = computed(() => !!token.value)
  const userName = computed(() => user.value?.name ?? user.value?.email ?? 'User')

  function _saveToken(t: string, u: User, ws: ApiWorkspace | null) {
    token.value = t
    user.value = u
    workspace.value = ws
    localStorage.setItem('xihe-token', t)
    localStorage.setItem('xihe-user', JSON.stringify(user.value))
    if (ws) localStorage.setItem('xihe-workspace', JSON.stringify(ws))
    else localStorage.removeItem('xihe-workspace')
  }

  async function login(email: string, password: string) {
    loading.value = true
    error.value = null
    try {
      const res = await api.login(email, password)
      const ws = res.workspace ?? (res.workspaceId ? { id: res.workspaceId, name: 'Default Workspace' } : null)
      _saveToken(res.accessToken, res.user, ws)
      clearSessionCaches()
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
      const ws = res.workspace ?? (res.workspaceId ? { id: res.workspaceId, name: 'Default Workspace' } : null)
      _saveToken(res.accessToken, res.user, ws)
      clearSessionCaches()
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

  function clearSessionCaches() {
    try {
      const sessionStore = useSessionStore()
      sessionStore.resetForUserSwitch()
    } catch {
      // Pinia not yet initialised — store will start fresh on next access.
    }
    try {
      const chatStore = useChatStore()
      chatStore.clearForUserSwitch()
    } catch {
      // Pinia not yet initialised — store will start fresh on next access.
    }
    try {
      const configStore = useConfigStore()
      configStore.clearForUserSwitch()
    } catch {
      // Pinia not yet initialised — store will start fresh on next access.
    }
  }

  function logout() {
    token.value = null
    user.value = null
    workspace.value = null
    error.value = null
    localStorage.removeItem('xihe-token')
    localStorage.removeItem('xihe-user')
    localStorage.removeItem('xihe-workspace')
    clearSessionCaches()
  }

  const currentWorkspaceId = computed(() => workspace.value?.id ?? null)

  return {
    token, user, workspace, loading, error, isAuthenticated, userName,
    currentWorkspaceId,
    login, register, logout,
  }
})
