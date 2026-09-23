import { test, expect } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

test.describe('Session switch between chat and workspace', () => {
  const sessionId = 'switch-session'
  const sessionTitle = 'Switch Test'
  const userMessage = 'Hello from chat'
  const workspaceId = 'workspace-1'

  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await setupMockSessions(page, {
      sessions: [{ id: sessionId, title: sessionTitle, workspaceId }],
      messages: {
        [sessionId]: [{ id: 'msg-1', sessionId, role: 'USER', content: userMessage, createdAt: new Date().toISOString() }],
      },
    })
  })

  test('chat and workspace share the same session messages', async ({ page }) => {
    await page.goto(`/workspace/${workspaceId}/chat/${sessionId}`)
    await expect(page.locator(`text=${userMessage}`)).toBeVisible({ timeout: 5000 })

    await page.locator('aside >> text=工作区').click()
    await page.waitForURL(`**/workspace/${workspaceId}`)
    await expect(page.locator(`text=${userMessage}`)).toBeVisible({ timeout: 5000 })
    await expect(page.locator('button[title="Switch to chat"]')).toBeVisible({ timeout: 5000 })

    await page.locator('button[title="Switch to chat"]').click()
    await page.waitForURL(`**/workspace/${workspaceId}/chat/${sessionId}`)
    await expect(page.locator(`text=${userMessage}`)).toBeVisible({ timeout: 5000 })
  })

  test('workspace session selector switches session', async ({ page }) => {
    await setupMockSessions(page, {
      sessions: [
        { id: sessionId, title: sessionTitle, workspaceId },
        { id: 'other-session', title: 'Other Session', workspaceId },
      ],
    })

    await page.goto(`/workspace/${workspaceId}`)
    await expect(page.locator('button[title="Switch to chat"]')).toBeVisible({ timeout: 5000 })

    const select = page.locator('select').first()
    await select.selectOption('other-session')
    await page.waitForURL(`**/workspace/${workspaceId}/chat/other-session`)
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 5000 })
  })

  test('workspace routes keep sessions isolated and resubscribe workspace events', async ({ page }) => {
    const firstWorkspace = 'workspace-1'
    const secondWorkspace = 'workspace-2'
    const firstSession = 'workspace-one-session'
    const secondSession = 'workspace-two-session'
    const firstMessage = 'Message from workspace one'
    const secondMessage = 'Message from workspace two'
    const workspaceEvents: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/workspaces/') && request.url().includes('/events')) {
        workspaceEvents.push(request.url())
      }
    })
    await setupMockSessions(page, {
      sessions: [
        { id: firstSession, title: 'Workspace One', workspaceId: firstWorkspace },
        { id: secondSession, title: 'Workspace Two', workspaceId: secondWorkspace },
      ],
      messages: {
        [firstSession]: [{ id: 'workspace-one-message', sessionId: firstSession, role: 'USER', content: firstMessage, createdAt: new Date().toISOString() }],
        [secondSession]: [{ id: 'workspace-two-message', sessionId: secondSession, role: 'USER', content: secondMessage, createdAt: new Date().toISOString() }],
      },
    })

    const firstHistory = page.waitForResponse((response) =>
      response.url().includes(`/api/v1/sessions/${firstSession}/messages`),
    )
    await page.goto(`/workspace/${firstWorkspace}/chat/${firstSession}`)
    await firstHistory
    await expect(page.getByText(firstMessage)).toBeVisible({ timeout: 5000 })
    await page.goto(`/workspace/${secondWorkspace}/chat/${secondSession}`)
    await expect(page.getByText(secondMessage)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(firstMessage)).toHaveCount(0)
    expect(workspaceEvents.some((url) => url.includes(`/workspaces/${firstWorkspace}/events`))).toBe(true)
    expect(workspaceEvents.some((url) => url.includes(`/workspaces/${secondWorkspace}/events`))).toBe(true)
  })

  test('switching away from an in-flight run detaches and replays on return', async ({ page }) => {
    const firstWorkspace = 'workspace-1'
    const secondWorkspace = 'workspace-2'
    const firstSession = 'in-flight-session'
    const secondSession = 'other-workspace-session'
    await setupMockAuth(page, { sse: { tokens: ['replayed response'], delayMs: 200 } })
    await setupMockSessions(page, {
      sessions: [
        { id: firstSession, title: 'In-flight', workspaceId: firstWorkspace },
        { id: secondSession, title: 'Other', workspaceId: secondWorkspace },
      ],
      messages: {
        [firstSession]: [],
        [secondSession]: [],
      },
    })
    let historyReads = 0
    await page.route(`**/api/v1/sessions/${firstSession}/messages*`, async (route) => {
      historyReads += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(historyReads >= 2
          ? [{ id: 'replayed-message', sessionId: firstSession, role: 'ASSISTANT', content: 'replayed response', createdAt: new Date().toISOString() }]
          : []),
      })
    })

    const firstHistory = page.waitForResponse((response) =>
      response.url().includes(`/api/v1/sessions/${firstSession}/messages`),
    )
    await page.goto(`/workspace/${firstWorkspace}/chat/${firstSession}`)
    await firstHistory
    const input = page.locator('[data-testid="chat-input"]')
    await input.fill('start a long run')
    await page.locator('button[aria-label="chat.send"], button[aria-label="发送"]').click()
    await expect(page.getByText('start a long run')).toBeVisible({ timeout: 5000 })

    await page.goto(`/workspace/${secondWorkspace}/chat/${secondSession}`)
    const returnedHistory = page.waitForResponse((response) =>
      response.url().includes(`/api/v1/sessions/${firstSession}/messages`),
    )
    await page.goto(`/workspace/${firstWorkspace}/chat/${firstSession}`)
    await returnedHistory
    expect(historyReads).toBeGreaterThanOrEqual(2)
    await expect(page.getByText('replayed response')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible()
  })
})
