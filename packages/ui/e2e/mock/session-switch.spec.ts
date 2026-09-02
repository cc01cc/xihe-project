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
    await page.goto(`/chat/${sessionId}`)
    await expect(page.locator(`text=${userMessage}`)).toBeVisible({ timeout: 5000 })

    await page.locator('aside >> text=工作区').click()
    await page.waitForURL(`**/workspace/${workspaceId}`)
    await expect(page.locator(`text=${userMessage}`)).toBeVisible({ timeout: 5000 })
    await expect(page.locator('button[title="Switch to chat"]')).toBeVisible({ timeout: 5000 })

    await page.locator('button[title="Switch to chat"]').click()
    await page.waitForURL(`**/chat/${sessionId}`)
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

    const select = page.locator('select')
    await select.selectOption('other-session')
    await page.waitForURL('**/chat/other-session')
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({ timeout: 5000 })
  })
})
