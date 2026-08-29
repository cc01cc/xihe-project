const API_BASE = '/api/v1'

export interface ProblemDetails {
  type?: string
  title?: string
  status: number
  code: string
  detail?: string
  requestId: string
}

export class ApiError extends Error {
  constructor(public readonly problem: ProblemDetails) {
    super(problem.detail || problem.code || `API error ${problem.status}`)
    this.name = 'ApiError'
  }
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
  })
}

async function checkedFetch(path: string, options?: RequestInit): Promise<Response> {
  const hasBody = options?.body !== undefined && options.body !== null
  const includeContentType = hasBody && !(options?.body instanceof FormData)
  const res = await fetch(endpoint(path), { ...options, headers: apiAuthHeaders(options?.headers, includeContentType) })
  if (res.status === 401) {
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

function runtimeMcpHeaders(): Record<string, string> {
  const userRaw = localStorage.getItem('xihe-user')
  const workspaceId = userRaw ? (JSON.parse(userRaw).workspaceId as string | undefined) : undefined
  return {
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    ...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
  }
}

async function callRuntimeTool<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  const res = await checkedFetch('/mcp', {
    method: 'POST',
    headers: runtimeMcpHeaders(),
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
    return request<{ accessToken: string; user: { id: string; email: string }; workspaceId?: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  },
  register(email: string, password: string, name: string) {
    return request<{ accessToken: string; user: { id: string; email: string }; workspaceId?: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    })
  },
  getSessions() {
    return request<{ sessions: Array<{ id: string; title: string }> }>('/sessions')
  },
  createSession(title?: string) {
    return request<{ id: string; title: string }>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ title }),
    })
  },
  deleteSession(id: string) {
    return apiDelete(`/sessions/${id}`)
  },
  getMessages(sessionId: string) {
    return request<Array<{ id: string; sessionId: string; role: string; content: string; createdAt: string; attachments?: Array<{ fileId: string; name: string; type: string; size: number }> }>>(`/sessions/${sessionId}/messages`)
  },
  deleteMessage(sessionId: string, messageId: string) {
    return apiDelete(`/sessions/${sessionId}/messages/${messageId}`)
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
  async listDirectory(path: string) {
    const raw = await callRuntimeTool<{ entries?: Array<{ name: string; path: string; is_dir?: boolean; type?: string; size?: number; modified?: string }> }>(
      'list_directory', { path }
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
  async readFile(path: string) {
    const content = await callRuntimeTool<string>('read_file', { path })
    return { content: typeof content === 'string' ? content : String(content) }
  },
  async writeFile(path: string, content: string) {
    await callRuntimeTool<string>('write_file', { path, content })
    return { success: true }
  },
  async deleteFile(path: string) {
    await callRuntimeTool<string>('delete_file', { path })
    return { success: true }
  },
  getMcpConfig(wsId: string) {
    return request<{ mcpServers?: string | Record<string, unknown> }>(`/workspaces/${wsId}/mcp-config`)
  },
  saveMcpConfig(wsId: string, mcpServers: string) {
    return request<{ status: string }>(`/workspaces/${wsId}/mcp-config`, {
      method: 'PUT',
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
