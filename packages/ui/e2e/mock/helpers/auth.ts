import type { Page } from '@playwright/test'

export interface MockSSEStream {
  tokens: string[]
  usage?: {
    inputTokens: number
    outputTokens: number
    cost?: number
    source: string
  }
  retryTokens?: string[]
  errorAfterTokens?: {
    code: string
    detail: string
    retryable?: boolean
  }
  delayMs?: number
}

export interface MockAuthOptions {
  sse?: MockSSEStream
}

export interface MockSessionRecord {
  id: string
  title: string
  createdAt?: string
  updatedAt?: string
  workspaceId?: string
}

export interface MockSessionOptions {
  sessions?: MockSessionRecord[]
  workspaceId?: string
  messages?: Record<string, Array<Record<string, unknown>>>
  createSession?: boolean
}

export async function setupMockAuth(page: Page, options: MockAuthOptions = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('xihe-token', 'mock-token')
    localStorage.setItem(
      'xihe-user',
      JSON.stringify({ id: 'user-1', email: 'test@xihe.local', name: 'Test User' }),
    )
    localStorage.setItem(
      'xihe-workspace',
      JSON.stringify({ id: 'workspace-1', name: 'Mock Workspace', ownerId: 'user-1' }),
    )
  })

  if (options.sse) {
    await page.addInitScript(({ tokens, retryTokens, errorAfterTokens, delayMs, optionsUsage }) => {
      const originalFetch = window.fetch.bind(window)
      let streamController: ReadableStreamDefaultController<Uint8Array> | null = null
      let streamClosed = false
      let streamReady = false
      let streamEmitted = false
      let shouldFail = Boolean(errorAfterTokens)

      const encode = (value: string) => new TextEncoder().encode(value)
      const event = (name: string, data: unknown) =>
        `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

      const emit = async () => {
        if (!streamController || streamClosed || streamEmitted) return
        streamEmitted = true
        try {
          const responseTokens = shouldFail ? tokens : (retryTokens ?? tokens)
          for (const token of responseTokens) {
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
            if (!streamController || streamClosed) return
            streamController.enqueue(encode(event('token', { content: token })))
          }
          if (shouldFail && errorAfterTokens) {
            streamController.enqueue(encode(event('error', errorAfterTokens)))
            shouldFail = false
            streamEmitted = false
            return
          }
          if (!streamClosed && optionsUsage) {
            streamController.enqueue(encode(event('usage', optionsUsage)))
          }
          if (!streamClosed) {
            streamController.enqueue(encode(event('done', {})))
            streamController.close()
            streamClosed = true
          }
        } catch {
          streamClosed = true
        }
      }

      window.fetch = async (input, init) => {
        const requestUrl = typeof input === 'string' ? input : input instanceof Request ? input.url : input.url
        if (requestUrl.includes('/api/v1/events')) {
          streamClosed = false
          streamReady = false
          streamEmitted = false
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller
              controller.enqueue(encode('retry: 1000\n\n'))
              if (streamReady) void emit()
            },
            cancel() {
              streamClosed = true
              streamController = null
            },
          })
          return new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          })
        }

        if (requestUrl.includes('/api/v1/chat') && (init?.method ?? (input instanceof Request ? input.method : 'GET')) === 'POST') {
          const response = await originalFetch(input, init)
          streamReady = true
          void emit()
          return response
        }

        return originalFetch(input, init)
      }
    }, {
      tokens: options.sse.tokens,
      optionsUsage: options.sse.usage,
      retryTokens: options.sse.retryTokens,
      errorAfterTokens: options.sse.errorAfterTokens,
      delayMs: options.sse.delayMs ?? 0,
    })
  }

  if (!options.sse) {
    await page.route('**/api/v1/events**', async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: 'retry: 5000\n\n',
      })
    })
  }

  await page.route('**/api/v1/chat', async (route) => {
    await route.fulfill({ status: 202, body: JSON.stringify({ status: 'accepted' }) })
  })

  await page.route('**/api/v1/models', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: {} }),
    })
  })

  await page.route('**/api/v1/**', async (route) => {
    const url = route.request().url()
    if (url.includes('/api/v1/workspaces/') && url.includes('/events')) {
      await route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
        body: 'retry: 1000\n\n',
      })
      return
    }
    if (url.includes('/api/v1/events') || url.includes('/chat') || url.includes('/models')) {
      return route.fallback()
    }
    const workspaceMatch = url.match(/\/api\/v1\/workspaces\/([^/?]+)$/)
    if (workspaceMatch?.[1] === 'current' && route.request().method() === 'GET') {
      await route.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({ code: 'WORKSPACE_NOT_FOUND', detail: 'No active workspace' }),
      })
      return
    }
    if (workspaceMatch && workspaceMatch[1] !== 'current' && route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: workspaceMatch[1],
          name: 'Mock Workspace',
          status: 'ready',
        }),
      })
      return
    }
    const sessionMatch = url.match(/\/api\/v1\/sessions\/([^/?]+)/)
    if (sessionMatch && route.request().method() === 'GET') {
      if (url.includes('/messages')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: sessionMatch[1],
          title: 'Mock Session',
          workspaceId: 'workspace-1',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          archived: false,
        }),
      })
      return
    }
    if (url.match(/\/api\/v1\/sessions(?:\?.*)?$/) && route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      })
      return
    }
    if (url.includes('/api/v1/policy/mode') && route.request().method() === 'GET') {
      const sessionId = new URL(url).searchParams.get('sessionId') ?? 'mock-session'
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessionId, mode: 'manual', sessionRules: 0 }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    })
  })
}

export async function setupMockSessions(page: Page, options: MockSessionOptions = {}) {
  const now = new Date().toISOString()
  const sessions = (options.sessions ?? []).map((session) => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt ?? now,
    updatedAt: session.updatedAt ?? session.createdAt ?? now,
    workspaceId: session.workspaceId ?? options.workspaceId ?? 'workspace-1',
    modelProvider: null,
    modelName: null,
    archived: false,
  }))
  const messages = options.messages ?? {}

  await page.route('**/api/v1/sessions', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions }),
      })
      return
    }
    if (route.request().method() === 'POST' && options.createSession) {
      const body = route.request().postDataJSON() as { title?: string } | null
      const created = {
        id: `mock-session-${Date.now()}`,
        title: body?.title ?? 'New Chat',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workspaceId: 'workspace-1',
        modelProvider: null,
        modelName: null,
        archived: false,
      }
      sessions.unshift(created)
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) })
      return
    }
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'SESSION_CREATION_DISABLED' }),
    })
  })

  await page.route('**/api/v1/sessions/**', async (route) => {
    const url = new URL(route.request().url())
    const parts = url.pathname.split('/').filter(Boolean)
    const sessionId = parts.at(-1) === 'messages' ? parts.at(-2) : parts.at(-1)
    if (!sessionId) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({}) })
      return
    }
    if (parts.at(-1) === 'messages' && route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(messages[sessionId] ?? []),
      })
      return
    }
    const session = sessions.find((item) => item.id === sessionId)
    if (route.request().method() === 'GET' && session) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) })
      return
    }
    await route.fulfill({ status: session ? 200 : 404, contentType: 'application/json', body: JSON.stringify(session ?? {}) })
  })
}
