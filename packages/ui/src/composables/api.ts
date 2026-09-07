const API_BASE = '/api/v1'

export interface ProblemDetails {
  type?: string
  title?: string
  status: number
  code: string
  detail?: string
  requestId: string
  runId?: string
  provider?: string
  model?: string
  retryable?: boolean
  outcome?: string
}

export interface ApiWorkspace {
  id: string
  name: string
  description?: string | null
  storageBackend?: string
  storageRef?: string
  createdAt?: string
  updatedAt?: string
}

export interface ApiSession {
  id: string
  title: string
  workspaceId?: string
  createdAt?: string
  updatedAt?: string
  modelProvider?: string
  modelName?: string
  providerConnectionId?: string
  connectionRevision?: number
}

export interface SessionResponse extends ApiSession {
  workspace?: ApiWorkspace
}

export interface SessionListResponse {
  sessions: SessionResponse[]
  workspace?: ApiWorkspace
}

export interface ChatApprovalDecisionResponse {
  status: 'accepted' | 'already_decided'
  requestId: string
  approved: boolean
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? value as JsonRecord : null
}

function normalizeWorkspace(value: unknown): ApiWorkspace | undefined {
  const record = asRecord(value)
  if (!record || typeof record.id !== 'string' || typeof record.name !== 'string') return undefined
  return {
    id: record.id,
    name: record.name,
    description: typeof record.description === 'string' ? record.description : record.description === null ? null : undefined,
    storageBackend: typeof record.storageBackend === 'string' ? record.storageBackend : undefined,
    storageRef: typeof record.storageRef === 'string' ? record.storageRef : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
  }
}

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.detail || problem.code || `API error ${problem.status}`)
    this.name = 'ApiError'
  }
}

function normalizeSession(value: unknown): SessionResponse {
  const root = asRecord(value)
  const record = asRecord(root?.session) ?? root
  if (!record || typeof record.id !== 'string') {
    throw new Error('Invalid session response: missing id')
  }
  const workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(record.workspace)
  return {
    id: record.id,
    title: typeof record.title === 'string' && record.title.length > 0 ? record.title : 'Untitled',
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : workspace?.id,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
    modelProvider: typeof record.modelProvider === 'string' ? record.modelProvider : undefined,
    modelName: typeof record.modelName === 'string' ? record.modelName : undefined,
    workspace,
  }
}

function normalizeWorkspaceResponse(value: unknown): ApiWorkspace {
  const root = asRecord(value)
  const workspace = normalizeWorkspace(root?.workspace) ?? normalizeWorkspace(root)
  if (!workspace) throw new Error('Invalid workspace response: missing id or name')
  return workspace
}

function endpoint(path: string): string {
  return path.startsWith('/api/v1/') || path.startsWith('/internal/v1/') ? path : `${API_BASE}${path}`
}

export function apiAuthHeaders(headers?: HeadersInit, includeContentType = true): Record<string, string> {
  const result: Record<string, string> = {}
  if (headers instanceof Headers) headers.forEach((value, key) => { result[key] = value })
  else if (Array.isArray(headers)) headers.forEach(([key, value]) => { result[key] = value })
  else Object.assign(result, headers ?? {})
  const token = localStorage.getItem('xihe-token')
  if (token) result.Authorization = `Bearer ${token}`
  if (includeContentType && !result['Content-Type']) result['Content-Type'] = 'application/json'
  return result
}

export async function apiErrorFromResponse(res: Response): Promise<never> {
  let problem: Partial<ProblemDetails> = {}
  try { problem = await res.json() as Partial<ProblemDetails> } catch { /* non-JSON upstream error */ }
  throw new ApiError({
    type: problem.type,
    title: problem.title,
    status: problem.status ?? res.status,
    code: problem.code ?? 'API_ERROR',
    detail: problem.detail || `API error ${problem.status ?? res.status}`,
    requestId: problem.requestId || res.headers?.get('X-Request-Id') || 'unknown',
    runId: problem.runId,
    provider: problem.provider,
    model: problem.model,
    retryable: problem.retryable,
    outcome: problem.outcome,
  })
}

async function checkedFetch(path: string, options?: RequestInit): Promise<Response> {
  const hasBody = options?.body !== undefined && options.body !== null
  const includeContentType = hasBody && !(options?.body instanceof FormData)
  const res = await fetch(endpoint(path), { ...options, headers: apiAuthHeaders(options?.headers, includeContentType) })
  const isAuthEndpoint = path === '/auth/login' || path === '/auth/register'
  if (res.status === 401 && !isAuthEndpoint) {
    localStorage.removeItem('xihe-token')
    localStorage.removeItem('xihe-user')
    if (!['/login', '/register'].includes(window.location.pathname)) window.location.href = '/login'
    throw new ApiError({ status: 401, code: 'AUTHORIZATION_REQUIRED', detail: 'Session expired', requestId: res.headers?.get('X-Request-Id') || 'unknown' })
  }
  if (!res.ok) return apiErrorFromResponse(res)
  return res
}

export async function apiRaw(path: string, options?: RequestInit): Promise<Response> {
  return checkedFetch(path, options)
}

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await checkedFetch(path, options)
  if (res.status === 204) return undefined as T
  return res.json()
}

export async function apiPost<T = unknown>(path: string, body?: BodyInit | null, headers?: Record<string, string>): Promise<T> {
  const requestHeaders = apiAuthHeaders(headers)
  if (body instanceof FormData) delete requestHeaders['Content-Type']
  const res = await checkedFetch(path, {
    method: 'POST',
    headers: requestHeaders,
    body,
  })
  if (res.status === 204) return undefined as T
  return res.json()
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await checkedFetch(path, {
    headers: apiAuthHeaders(undefined, false),
  })
  if (res.status === 204) return undefined as T
  return res.json()
}

export async function apiDelete(path: string): Promise<void> {
  await checkedFetch(path, {
    method: 'DELETE',
    headers: apiAuthHeaders(undefined, false),
  })
}

export function workspaceHeaders(workspaceId: string | null | undefined): Record<string, string> {
  if (!workspaceId || workspaceId.trim().length === 0) {
    throw new ApiError({
      status: 400,
      code: 'WORKSPACE_CONTEXT_REQUIRED',
      detail: 'Workspace context is required',
      requestId: 'client',
    })
  }
  return { 'X-Workspace-Id': workspaceId }
}

function runtimeMcpHeaders(workspaceId: string): Record<string, string> {
  return {
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    ...workspaceHeaders(workspaceId),
  }
}

async function callRuntimeTool<T>(tool: string, args: Record<string, unknown>, workspaceId: string): Promise<T> {
  const res = await checkedFetch('/mcp', {
    method: 'POST',
    headers: runtimeMcpHeaders(workspaceId),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: Date.now(),
      params: { name: tool, arguments: args },
    }),
  })
  const text = await res.text()
  const jsonLine = text.startsWith('data:')
    ? text.split('\n').find((line) => line.startsWith('data:'))!.slice(5).trim()
    : text
  const body = JSON.parse(jsonLine)
  if (body.error) {
    throw new ApiError({
      status: 502,
      code: 'MCP_TOOL_ERROR',
      detail: body.error.message || 'MCP tool call failed',
      requestId: res.headers.get('X-Request-Id') || 'unknown',
    })
  }
  const result = body.result
  if (result?.isError) {
    throw new ApiError({
      status: 502,
      code: 'MCP_TOOL_ERROR',
      detail: result.content?.[0]?.text || 'MCP tool error',
      requestId: res.headers.get('X-Request-Id') || 'unknown',
    })
  }
  if (result?.structuredContent !== undefined) return result.structuredContent as T
  const textContent = result?.content?.[0]?.text
  if (typeof textContent === 'string') {
    try { return JSON.parse(textContent) as T } catch { return textContent as T }
  }
  return result as T
}

export const api = {
  login(email: string, password: string) {
    return request<{ accessToken: string; user: { id: string; email: string; workspaceId?: string }; workspaceId?: string; workspace?: ApiWorkspace }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  },
  register(email: string, password: string, name: string) {
    return request<{ accessToken: string; user: { id: string; email: string; workspaceId?: string }; workspaceId?: string; workspace?: ApiWorkspace }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    })
  },
  async getSessions(): Promise<SessionListResponse> {
    const payload = await request<unknown>('/sessions')
    const root = asRecord(payload)
    const rawSessions = Array.isArray(root?.sessions) ? root.sessions : Array.isArray(payload) ? payload : null
    if (!rawSessions) throw new Error('Invalid sessions response: missing sessions')
    return {
      sessions: rawSessions.map(normalizeSession),
      workspace: normalizeWorkspace(root?.workspace),
    }
  },
  async getSession(id: string): Promise<SessionResponse> {
    return normalizeSession(await request<unknown>(`/sessions/${encodeURIComponent(id)}`))
  },
  async createSession(title?: string): Promise<SessionResponse> {
    const body = title === undefined ? {} : { title }
    return normalizeSession(await request<unknown>('/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
  },
  async updateSession(id: string, patch: { title?: string; modelProvider?: string; modelName?: string; providerConnectionId?: string }): Promise<SessionResponse> {
    return normalizeSession(await request<unknown>(`/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }))
  },
  deleteSession(id: string) {
    return apiDelete(`/sessions/${encodeURIComponent(id)}`)
  },
  getMessages(sessionId: string) {
    return request<Array<{ id: string; sessionId: string; role: string; content: string; createdAt: string; runId?: string; runStatus?: string; terminalOutcome?: string; errorCode?: string; error?: string; retryable?: boolean; attachments?: Array<{ fileId: string; name: string; type: string; size: number }> }>>(`/sessions/${encodeURIComponent(sessionId)}/messages`)
  },
  deleteMessage(sessionId: string, messageId: string) {
    return apiDelete(`/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`)
  },
  decideChatApproval(requestId: string, approved: boolean): Promise<ChatApprovalDecisionResponse> {
    return request<ChatApprovalDecisionResponse>(`/chat/approvals/${encodeURIComponent(requestId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ approved }),
    })
  },
  getHealth() {
    return request<{ status: string }>('/health')
  },
  getServiceStatus() {
    return request<{
      status: string
      timestamp: number
      services: Array<{
        name: string
        key: string
        status: string
        responseMs?: number
        error?: string
        version?: string
        database?: string
        size?: string
        connections?: number
        url?: string
        details?: string
      }>
    }>('/status')
  },
  async listDirectory(path: string, workspaceId: string) {
    const raw = await callRuntimeTool<{ entries?: Array<{ name: string; path: string; is_dir?: boolean; type?: string; size?: number; modified?: string }> }>(
      'list_directory', { path }, workspaceId
    )
    const entries = (raw.entries ?? []).map((e) => ({
      name: e.name,
      path: e.path,
      type: e.type ?? (e.is_dir ? 'directory' : 'file'),
      size: e.size,
      modified: e.modified,
    }))
    return { entries }
  },
  async readFile(path: string, workspaceId: string) {
    const content = await callRuntimeTool<string>('read_file', { path }, workspaceId)
    return { content: typeof content === 'string' ? content : String(content) }
  },
  async writeFile(path: string, content: string, workspaceId: string) {
    await callRuntimeTool<string>('write_file', { path, content }, workspaceId)
    return { success: true }
  },
  async deleteFile(path: string, workspaceId: string) {
    await callRuntimeTool<string>('delete_file', { path }, workspaceId)
    return { success: true }
  },
  async moveFile(from: string, to: string, workspaceId: string) {
    await callRuntimeTool<string>('move_file', { from, to }, workspaceId)
    return { success: true }
  },
  async copyFile(from: string, to: string, workspaceId: string) {
    await callRuntimeTool<string>('copy_file', { from, to }, workspaceId)
    return { success: true }
  },
  async createDirectory(path: string, workspaceId: string) {
    await callRuntimeTool<string>('mkdir', { path }, workspaceId)
    return { success: true }
  },
  getMcpConfig(wsId: string) {
    return request<{ mcpServers?: string | Record<string, unknown> }>(`/workspaces/${encodeURIComponent(wsId)}/mcp-config`, {
      headers: workspaceHeaders(wsId),
    })
  },
  async getCurrentWorkspace(): Promise<ApiWorkspace> {
    return normalizeWorkspaceResponse(await request<unknown>('/workspaces/current'))
  },
  async getWorkspace(wsId: string): Promise<ApiWorkspace> {
    return normalizeWorkspaceResponse(await request<unknown>(`/workspaces/${encodeURIComponent(wsId)}`, {
      headers: workspaceHeaders(wsId),
    }))
  },
  async createWorkspace(input: {
    name?: string
    description?: string | null
    profile?: 'strict' | 'coding' | 'isolated'
  }): Promise<ApiWorkspace> {
    const body: Record<string, unknown> = {}
    if (input.name !== undefined) body.name = input.name
    if (input.description !== undefined) body.description = input.description
    if (input.profile !== undefined) body.profile = input.profile
    // image is server-allowlisted (v1: xihe/workspace:latest); UI keeps it read-only.
    return normalizeWorkspaceResponse(await request<unknown>('/workspaces', {
      method: 'POST',
      body: JSON.stringify(body),
    }))
  },
  async updateWorkspace(wsId: string, patch: { name?: string; description?: string | null }): Promise<ApiWorkspace> {
    return normalizeWorkspaceResponse(await request<unknown>(`/workspaces/${encodeURIComponent(wsId)}`, {
      method: 'PATCH',
      headers: workspaceHeaders(wsId),
      body: JSON.stringify(patch),
    }))
  },
  deleteWorkspace(wsId: string) {
    return request<void>(`/workspaces/${encodeURIComponent(wsId)}`, {
      method: 'DELETE',
      headers: workspaceHeaders(wsId),
    })
  },
  getWorkspaceEnvironment(wsId: string) {
    return request<{
      workspaceId: string
      status: string
      storageBackend: string
      storageRef: string
      executionSpec?: { status: string; generation: number; sandboxSpecHash: string }
      assignment?: { status: string; generation: number; sandboxSpecHash: string }
      runtime: { status: string; deviceId: string; lastHeartbeatAt: string }
    }>(`/workspaces/${encodeURIComponent(wsId)}/environment`, {
      headers: workspaceHeaders(wsId),
    })
  },
  /** M4: trigger async materialization (202). Poll getWorkspaceEnvironment for progress. */
  materializeWorkspace(wsId: string) {
    return request<{ status: string }>(`/workspaces/${encodeURIComponent(wsId)}/materialize`, {
      method: 'POST',
      headers: workspaceHeaders(wsId),
    })
  },
  saveMcpConfig(wsId: string, mcpServers: string) {
    return request<{ status: string }>(`/workspaces/${encodeURIComponent(wsId)}/mcp-config`, {
      method: 'PUT',
      headers: workspaceHeaders(wsId),
      body: JSON.stringify({ mcpServers }),
    })
  },
  startOAuthSession(body: {
    workspaceId: string
    serverId: string
    remoteEndpoint: string
    clientId: string
    authorizationEndpoint: string
    tokenEndpoint: string
    redirectUri: string
    scope: string
  }) {
    return request<{ state: string; authorizationUrl: string; expiresAtMillis: number }>('/oauth/sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
  completeOAuthSession(state: string, code: string) {
    const params = new URLSearchParams({ state, code })
    return request<{ status: string }>(`/oauth/callback?${params.toString()}`)
  },
}
