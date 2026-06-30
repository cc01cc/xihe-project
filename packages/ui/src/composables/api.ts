const API_BASE = '/api/v1'

export async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem('xihe-token')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options?.headers as Record<string, string>),
  }
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers })
  if (res.status === 401) {
    localStorage.removeItem('xihe-token')
    localStorage.removeItem('xihe-user')
    const publicPaths = ['/login', '/register']
    if (!publicPaths.includes(window.location.pathname)) {
      window.location.href = '/login'
    }
    throw new Error('Session expired')
  }
  if (!res.ok) throw new Error(`API error ${res.status}`)
  return res.json()
}

export async function apiPost<T = unknown>(path: string, body?: BodyInit | null, headers?: Record<string, string>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...(headers ?? {}), Authorization: `Bearer ${localStorage.getItem('xihe-token') ?? ''}` },
    body,
  })
  if (!res.ok) throw new Error(`API error ${res.status}`)
  return res.json()
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Authorization: `Bearer ${localStorage.getItem('xihe-token') ?? ''}` },
  })
  if (!res.ok) throw new Error(`API error ${res.status}`)
  return res.json()
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${localStorage.getItem('xihe-token') ?? ''}` },
  })
  if (!res.ok) throw new Error(`API error ${res.status}`)
}

export const api = {
  login(email: string, password: string) {
    return request<{ accessToken: string; user: { id: string; email: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  },
  register(email: string, password: string, name: string) {
    return request<{ accessToken: string; user: { id: string; email: string } }>('/auth/register', {
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
    return fetch(`${API_BASE}/sessions/${id}`, { method: 'DELETE' })
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
    return request<{ mcpServers?: string }>(`/workspaces/${wsId}/mcp-config`)
  },
  saveMcpConfig(wsId: string, mcpServers: string) {
    return request<{ status: string }>(`/workspaces/${wsId}/mcp-config`, {
      method: 'PUT',
      body: JSON.stringify({ mcpServers }),
    })
  },
}
