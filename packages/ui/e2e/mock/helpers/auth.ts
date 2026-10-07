import type { Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'

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
  holdOpen?: boolean
}

export interface MockAuthOptions {
  sse?: MockSSEStream
}

export interface MockSessionRecord {
  id: string
  title: string
  agentPrincipalId?: string | null
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

const MOCK_ROOT_BRANCH_ID = '00000000-0000-4000-8000-000000000001'
type MockBranch = {
  branchId: string
  parentBranchId: string | null
  forkPointMessageId: string | null
  forkPointRunId: string | null
  createdAt: string
}

export async function setupMockAuth(page: Page, options: MockAuthOptions = {}) {
  const branchesBySession = new Map<string, MockBranch[]>()
  const branchResponses = new Map<string, { requestHash: string; response: { branchId: string; parentBranchId: string; forkPointMessageId: string } }>()
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
    await page.addInitScript(({ tokens, retryTokens, errorAfterTokens, delayMs, optionsUsage, holdOpen }) => {
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
          if (holdOpen) return
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
      holdOpen: options.sse.holdOpen ?? false,
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
    const body = route.request().postDataJSON() as { branchId?: string } | null
    if (!body?.branchId) {
      await route.fulfill({
        status: 400,
        contentType: 'application/problem+json',
        body: JSON.stringify({ code: 'INVALID_REQUEST', detail: 'branchId is required' }),
      })
      return
    }
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
    const branchRoute = url.match(/\/api\/v1\/sessions\/([^/?]+)\/branches(?:\?|$)/)
    if (branchRoute) {
      const sessionId = branchRoute[1]
      const method = route.request().method()
      if (method === 'GET') {
        const items = branchesBySession.get(sessionId) ?? [{
          branchId: MOCK_ROOT_BRANCH_ID,
          parentBranchId: null,
          forkPointMessageId: null,
          forkPointRunId: null,
          createdAt: '2026-09-29T00:00:00.000Z',
        }]
        branchesBySession.set(sessionId, items)
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessionId, items }),
        })
        return
      }
      if (method === 'POST') {
        const body = route.request().postDataJSON() as {
          sourceBranchId?: string
          anchorMessageId?: string
        }
        if (!body.sourceBranchId || !body.anchorMessageId || !route.request().headers()['idempotency-key']) {
          await route.fulfill({
            status: 400,
            contentType: 'application/problem+json',
            body: JSON.stringify({ code: 'INVALID_REQUEST', detail: 'branch request is incomplete' }),
          })
          return
        }
        const key = `${sessionId}:${route.request().headers()['idempotency-key']}`
        const requestHash = `${body.sourceBranchId}:${body.anchorMessageId}`
        const prior = branchResponses.get(key)
        if (prior && prior.requestHash !== requestHash) {
          await route.fulfill({
            status: 409,
            contentType: 'application/problem+json',
            body: JSON.stringify({ code: 'IDEMPOTENCY_KEY_CONFLICT', detail: 'branch key conflict' }),
          })
          return
        }
        const response = prior?.response ?? {
          branchId: randomUUID(),
          parentBranchId: body.sourceBranchId,
          forkPointMessageId: body.anchorMessageId,
        }
        branchResponses.set(key, { requestHash, response })
        const items = branchesBySession.get(sessionId) ?? [{
          branchId: MOCK_ROOT_BRANCH_ID,
          parentBranchId: null,
          forkPointMessageId: null,
          forkPointRunId: null,
          createdAt: '2026-09-29T00:00:00.000Z',
        }]
        if (!items.some((item) => item.branchId === response.branchId)) {
          items.push({
            branchId: response.branchId,
            parentBranchId: response.parentBranchId,
            forkPointMessageId: response.forkPointMessageId,
            forkPointRunId: null,
            createdAt: new Date().toISOString(),
          })
        }
        branchesBySession.set(sessionId, items)
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(response),
        })
        return
      }
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
  const branches = new Map<string, MockBranch[]>(sessions.map((session) => [session.id, [{
    branchId: MOCK_ROOT_BRANCH_ID,
    parentBranchId: null,
    forkPointMessageId: null,
    forkPointRunId: null,
    createdAt: now,
  }]]))

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
      const body = route.request().postDataJSON() as { title?: string; agentPrincipalId?: string } | null
      const created = {
        id: `mock-session-${Date.now()}`,
        title: body?.title ?? 'New Chat',
        agentPrincipalId: body?.agentPrincipalId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workspaceId: 'workspace-1',
        modelProvider: null,
        modelName: null,
        archived: false,
      }
      sessions.unshift(created)
      branches.set(created.id, [{
        branchId: MOCK_ROOT_BRANCH_ID,
        parentBranchId: null,
        forkPointMessageId: null,
        forkPointRunId: null,
        createdAt: created.createdAt,
      }])
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
    if (parts.at(-1) === 'branches') {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ sessionId, items: branches.get(sessionId) ?? [] }),
        })
        return
      }
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as {
          sourceBranchId?: string
          anchorMessageId?: string
        } | null
        const key = route.request().headers()['idempotency-key']
        if (!body?.sourceBranchId || !body.anchorMessageId || !key) {
          await route.fulfill({
            status: 400,
            contentType: 'application/problem+json',
            body: JSON.stringify({ code: 'INVALID_REQUEST', detail: 'branch request is incomplete' }),
          })
          return
        }
        const branchId = randomUUID()
        const response = {
          branchId,
          parentBranchId: body.sourceBranchId,
          forkPointMessageId: body.anchorMessageId,
        }
        const items = branches.get(sessionId) ?? []
        items.push({
          branchId,
          parentBranchId: body.sourceBranchId,
          forkPointMessageId: body.anchorMessageId,
          forkPointRunId: null,
          createdAt: new Date().toISOString(),
        })
        branches.set(sessionId, items)
        await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(response) })
        return
      }
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
