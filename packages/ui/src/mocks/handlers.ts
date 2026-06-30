import { http, HttpResponse } from 'msw'

const MOCK_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIiwidXNlcklkIjoiMSIsImVtYWlsIjoidGVzdEB0ZXN0LmNvbSJ9.mock'

const API = '/api/v1'

export const handlers = [
  // Auth
  http.post(`${API}/auth/login`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    if (body.email === 'test@test.com' && body.password === 'password') {
      return HttpResponse.json({
        accessToken: MOCK_TOKEN,
        refreshToken: 'mock-refresh-token',
        user: { id: '1', email: 'test@test.com', name: 'Test', role: 'user' },
      })
    }
    return HttpResponse.json({ error: 'Invalid credentials' }, { status: 401 })
  }),

  http.post(`${API}/auth/register`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    if (body.email && body.password) {
      return HttpResponse.json({
        accessToken: MOCK_TOKEN,
        refreshToken: 'mock-refresh-token',
        user: { id: '1', email: body.email, name: body.name, role: 'user' },
      })
    }
    return HttpResponse.json({ error: 'Invalid input' }, { status: 400 })
  }),

  // Session CRUD
  http.get(`${API}/sessions`, () =>
    HttpResponse.json({
      sessions: [
        { id: '1', title: 'Chat 1', createdAt: '2026-05-31T10:00:00Z', updatedAt: '2026-05-31T10:00:00Z' },
        { id: '2', title: 'Chat 2', createdAt: '2026-05-30T10:00:00Z', updatedAt: '2026-05-30T10:00:00Z' },
      ],
    })
  ),

  http.post(`${API}/sessions`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    return HttpResponse.json({
      id: String(Date.now()),
      title: (body.title as string) || 'New Chat',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { status: 201 })
  }),

  http.delete(`${API}/sessions/:id`, () => new HttpResponse(null, { status: 204 })),

  // Chat SSE
  http.post(`${API}/chat`, () =>
    HttpResponse.json({ message: 'Streaming started', sessionId: '1' }, { status: 202 })
  ),

  // SSE events endpoint
  http.get(`${API}/events`, () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"token","content":"Hello"}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: {"type":"token","content":" World"}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: {"type":"done","usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'))
        controller.close()
      },
    })
    return new HttpResponse(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  }),

  // Health
  http.get(`${API}/health`, () =>
    HttpResponse.json({ status: 'UP' })
  ),
]
