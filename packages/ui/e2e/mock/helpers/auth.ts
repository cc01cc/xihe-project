import type { Page } from '@playwright/test'

export interface MockSSEStream {
  tokens: string[]
}

export interface MockAuthOptions {
  sse?: MockSSEStream
}

function buildSSEEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function buildSSEBody(tokens: string[]): string {
  const parts: string[] = ['retry: 5000\n\n']
  for (const token of tokens) {
    parts.push(buildSSEEvent('token', { content: token }))
  }
  parts.push(buildSSEEvent('done', {}))
  return parts.join('')
}

export async function setupMockAuth(page: Page, options: MockAuthOptions = {}) {
  await page.addInitScript(() => {
    localStorage.setItem('xihe-token', 'mock-token')
    localStorage.setItem(
      'xihe-user',
      JSON.stringify({ id: 'user-1', email: 'test@xihe.local', name: 'Test User' }),
    )
  })

  await page.route('**/api/v1/events**', async (route) => {
    const body = options.sse ? buildSSEBody(options.sse.tokens) : 'retry: 5000\n\n'
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body,
    })
  })

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
    if (url.includes('/events') || url.includes('/chat') || url.includes('/models')) {
      return route.fallback()
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    })
  })
}
