import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, type ApiSession } from '../composables/api'
import type { Session, SessionContext, RAGContext, MCPContext, FileContext, AttachmentFile } from '../types'

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

function toSession(record: ApiSession): Session {
  const now = new Date().toISOString()
  return {
    id: record.id,
    title: record.title || 'Untitled',
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? record.createdAt ?? now,
    workspaceId: record.workspaceId,
    modelProvider: record.modelProvider,
    modelName: record.modelName,
    providerConnectionId: record.providerConnectionId,
    connectionRevision: record.connectionRevision,
    context: createEmptyContext(),
  }
}

export const useSessionStore = defineStore('session', () => {
  // Session metadata is a server projection. localStorage must not resurrect a
  // session after a user switch or make up an ID before the CP responds.
  const sessions = ref<Session[]>([])
  const currentSessionId = ref<string | null>(null)
  const searchQuery = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)
  let loadPromise: Promise<Session[]> | null = null
  let storeGeneration = 0

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

  function replaceFromServer(records: ApiSession[]) {
    sessions.value = records.map(toSession)
    if (currentSessionId.value && !sessions.value.some((session) => session.id === currentSessionId.value)) {
      currentSessionId.value = null
    }
  }

  function resetForUserSwitch() {
    storeGeneration += 1
    sessions.value = []
    currentSessionId.value = null
    error.value = null
    attachments.value = {}
    fileContexts.value = {}
  }

  async function loadSessions(): Promise<Session[]> {
    if (loadPromise) return loadPromise
    const generation = storeGeneration
    loading.value = true
    error.value = null
    loadPromise = (async () => {
      try {
        const response = await api.getSessions()
        if (generation !== storeGeneration) return sessions.value
        replaceFromServer(response.sessions)
        return sessions.value
      } catch (cause) {
        if (generation === storeGeneration) {
          error.value = cause instanceof Error ? cause.message : 'Failed to load sessions'
        }
        throw cause
      } finally {
        if (generation === storeGeneration) loading.value = false
      }
    })()
    try {
      return await loadPromise
    } finally {
      loadPromise = null
    }
  }

  async function loadSession(id: string): Promise<Session> {
    const response = await api.getSession(id)
    const session = toSession(response)
    upsertSession(session)
    return session
  }

  function upsertSession(session: Session) {
    const index = sessions.value.findIndex((item) => item.id === session.id)
    if (index >= 0) sessions.value.splice(index, 1, session)
    else sessions.value.unshift(session)
  }

  async function createSession(title = 'New Chat'): Promise<Session> {
    const response = await api.createSession(title)
    const session = toSession(response)
    upsertSession(session)
    currentSessionId.value = session.id
    error.value = null
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

  async function deleteSession(id: string): Promise<void> {
    await api.deleteSession(id)
    const index = sessions.value.findIndex((s) => s.id === id)
    if (index >= 0) {
      sessions.value.splice(index, 1)
      if (currentSessionId.value === id) {
        currentSessionId.value = sessions.value[0]?.id ?? null
      }
    }
  }

  async function updateSession(
    id: string,
    patch: { title?: string; modelProvider?: string; modelName?: string; providerConnectionId?: string },
  ): Promise<Session> {
    const updated = toSession(await api.updateSession(id, patch))
    upsertSession(updated)
    return updated
  }

  async function renameSession(id: string, title: string): Promise<Session> {
    return updateSession(id, { title })
  }

  function selectSession(id: string) {
    currentSessionId.value = id
  }

  async function updateSessionTitle(id: string, title: string): Promise<Session> {
    return renameSession(id, title)
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
    loading,
    error,
    currentSession,
    currentSessionContext,
    currentSessionAttachments,
    currentSessionFileContext,
    currentAgentIds,
    filteredSessions,
    groupedSessions,
    loadSessions,
    loadSession,
    createSession,
    ensureSession,
    deleteSession,
    renameSession,
    selectSession,
    updateSessionTitle,
    updateSession,
    updateSessionContext,
    setSessionAgents,
    setRAGContext,
    setMCPContext,
    setFileContext,
    getAttachments,
    addAttachment,
    removeAttachment,
    clearAttachments,
    resetForUserSwitch,
  }
})
