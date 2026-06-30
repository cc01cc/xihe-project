import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import type { Session } from '../types'

function generateId(): string {
  return crypto.randomUUID()
}

function getTimeGroup(dateStr: string): 'today' | 'yesterday' | 'earlier' {
  const date = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  if (date >= today) return 'today'
  if (date >= yesterday) return 'yesterday'
  return 'earlier'
}

export const useSessionStore = defineStore('session', () => {
  const sessions = useLocalStorage<Session[]>('xihe-sessions', [])
  const currentSessionId = ref<string | null>(null)
  const searchQuery = ref('')

  const currentSession = computed(() => {
    if (!currentSessionId.value) return null
    return sessions.value.find((s) => s.id === currentSessionId.value) ?? null
  })

  const filteredSessions = computed(() => {
    if (!searchQuery.value.trim()) return sessions.value
    const q = searchQuery.value.toLowerCase()
    return sessions.value.filter((s) => s.title.toLowerCase().includes(q))
  })

  const groupedSessions = computed(() => {
    const groups: Record<string, Session[]> = { today: [], yesterday: [], earlier: [] }
    for (const session of filteredSessions.value) {
      const group = getTimeGroup(session.updatedAt)
      groups[group].push(session)
    }
    return groups
  })

  function createSession(): Session {
    const session: Session = {
      id: generateId(),
      title: 'New Chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    sessions.value.unshift(session)
    currentSessionId.value = session.id
    return session
  }

  /** @deprecated Use configStore.setSessionModel(provider, model) instead. model binding moved to configStore in PLAN-056. */
  function setSessionModelId(id: string, modelId: string) {
    const session = sessions.value.find((s) => s.id === id)
    if (session) {
      session.modelId = modelId
    }
  }

  function deleteSession(id: string) {
    const index = sessions.value.findIndex((s) => s.id === id)
    if (index >= 0) {
      sessions.value.splice(index, 1)
      if (currentSessionId.value === id) {
        currentSessionId.value = sessions.value[0]?.id ?? null
      }
    }
  }

  function renameSession(id: string, title: string) {
    const session = sessions.value.find((s) => s.id === id)
    if (session) {
      session.title = title
      session.updatedAt = new Date().toISOString()
    }
  }

  function selectSession(id: string) {
    currentSessionId.value = id
    const session = sessions.value.find((s) => s.id === id)
    if (session) {
      session.updatedAt = new Date().toISOString()
    }
  }

  function updateSessionTitle(id: string, title: string) {
    renameSession(id, title)
  }

  return {
    sessions,
    currentSessionId,
    searchQuery,
    currentSession,
    filteredSessions,
    groupedSessions,
    createSession,
    deleteSession,
    renameSession,
    selectSession,
    updateSessionTitle,
    setSessionModelId,
  }
})
