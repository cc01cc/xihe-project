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

function authHeaders(headers?: HeadersInit, includeContentType = true): Record<string, string> {
  const result: Record<string, string> = {}
  if (headers instanceof Headers) headers.forEach((value, key) => { result[key] = value })
  else if (Array.isArray(headers)) headers.forEach(([key, value]) => { result[key] = value })
  else Object.assign(result, headers ?? {})
  const token = localStorage.getItem('xihe-token')
  if (token) result.Authorization = `Bearer ${token}`
  if (includeContentType && !result['Content-Type']) result['Content-Type'] = 'application/json'
  return result
}

async function throwApiError(res: Response): Promise<never> {
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
  const res = await fetch(endpoint(path), { ...options, headers: authHeaders(options?.headers, includeContentType) })
  if (res.status === 401) {
    localStorage.removeItem('xihe-token')
    localStorage.removeItem('xihe-user')
    if (!['/login', '/register'].includes(window.location.pathname)) window.location.href = '/login'
    throw new ApiError({ status: 401, code: 'AUTHORIZATION_REQUIRED', detail: 'Session expired', requestId: res.headers?.get('X-Request-Id') || 'unknown' })
  }
  if (!res.ok) return throwApiError(res)
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
  const requestHeaders = authHeaders(headers)
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
    headers: authHeaders(undefined, false),
  })
  if (res.status === 204) return undefined as T
  return res.json()
}

export async function apiDelete(path: string): Promise<void> {
  await checkedFetch(path, {
    method: 'DELETE',
    headers: authHeaders(undefined, false),
  })
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
  listDirectory(path: string) {
    return request<{ entries: Array<{ name: string; path: string; type: string; size?: number; modified?: string }> }>(
      `/mcp/runtime__list_directory`, { method: 'POST', body: JSON.stringify({ path }) }
    )
  },
  readFile(path: string) {
    return request<{ content: string }>(
      `/mcp/runtime__read_file`, { method: 'POST', body: JSON.stringify({ path }) }
    )
  },
  writeFile(path: string, content: string) {
    return request<{ success: boolean }>(
      `/mcp/runtime__write_file`, { method: 'POST', body: JSON.stringify({ path, content }) }
    )
  },
  deleteFile(path: string) {
    return request<{ success: boolean }>(
      `/mcp/runtime__delete_file`, { method: 'POST', body: JSON.stringify({ path }) }
    )
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
