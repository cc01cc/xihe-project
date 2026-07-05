import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useLocalStorage } from '@vueuse/core'
import type { Session, SessionContext, RAGContext, MCPContext, FileContext, AttachmentFile } from '../types'

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

function createEmptyContext(): SessionContext {
  return {
    agents: [],
    ragContext: undefined,
    mcpContext: undefined,
    fileContext: undefined,
  }
}

export const useSessionStore = defineStore('session', () => {
  const sessions = useLocalStorage<Session[]>('xihe-sessions', [])
  const currentSessionId = ref<string | null>(null)
  const searchQuery = ref('')

  // Cross-view state that is intentionally not persisted via localStorage.
  // PLAN-030 will implement the backend session-scoped attachment store.
  const attachments = ref<Record<string, AttachmentFile[]>>({})
  const fileContexts = ref<Record<string, FileContext>>({})

  const currentSession = computed(() => {
    if (!currentSessionId.value) return null
    return sessions.value.find((s) => s.id === currentSessionId.value) ?? null
  })

  const currentSessionContext = computed(() => {
    return currentSession.value?.context ?? createEmptyContext()
  })

  const currentSessionAttachments = computed(() => {
    if (!currentSessionId.value) return []
    return attachments.value[currentSessionId.value] ?? []
  })

  const currentSessionFileContext = computed(() => {
    if (!currentSessionId.value) return undefined
    return fileContexts.value[currentSessionId.value]
  })

  const currentAgentIds = computed(() => currentSessionContext.value.agents)

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
      context: createEmptyContext(),
    }
    sessions.value.unshift(session)
    currentSessionId.value = session.id
    return session
  }

  function ensureSession(id: string): Session | null {
    const session = sessions.value.find((s) => s.id === id)
    if (!session) return null
    if (!session.context) {
      session.context = createEmptyContext()
    }
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
    const session = ensureSession(id)
    if (session) {
      session.updatedAt = new Date().toISOString()
    }
  }

  function updateSessionTitle(id: string, title: string) {
    renameSession(id, title)
  }

  function updateSessionContext(id: string, context: Partial<SessionContext>) {
    const session = ensureSession(id)
    if (!session) return
    const base = session.context ?? createEmptyContext()
    session.context = { ...base, ...context }
    session.updatedAt = new Date().toISOString()
  }

  function setSessionAgents(id: string, agentIds: string[]) {
    updateSessionContext(id, { agents: agentIds })
  }

  function setRAGContext(id: string, ragContext: RAGContext) {
    updateSessionContext(id, { ragContext })
  }

  function setMCPContext(id: string, mcpContext: MCPContext) {
    updateSessionContext(id, { mcpContext })
  }

  function setFileContext(id: string, fileContext: FileContext) {
    const session = ensureSession(id)
    if (session) {
      fileContexts.value[id] = { ...fileContexts.value[id], ...fileContext }
      updateSessionContext(id, { fileContext })
    }
  }

  function getAttachments(id: string): AttachmentFile[] {
    return attachments.value[id] ?? []
  }

  function addAttachment(id: string, attachment: AttachmentFile) {
    if (!attachments.value[id]) {
      attachments.value[id] = []
    }
    attachments.value[id].push(attachment)
  }

  function removeAttachment(id: string, attachmentId: string) {
    const list = attachments.value[id]
    if (!list) return
    attachments.value[id] = list.filter((a) => a.id !== attachmentId)
  }

  function clearAttachments(id: string) {
    delete attachments.value[id]
  }

  return {
    sessions,
    currentSessionId,
    searchQuery,
    currentSession,
    currentSessionContext,
    currentSessionAttachments,
    currentSessionFileContext,
    currentAgentIds,
    filteredSessions,
    groupedSessions,
    createSession,
    ensureSession,
    deleteSession,
    renameSession,
    selectSession,
    updateSessionTitle,
    setSessionModelId,
    updateSessionContext,
    setSessionAgents,
    setRAGContext,
    setMCPContext,
    setFileContext,
    getAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
  }
})
