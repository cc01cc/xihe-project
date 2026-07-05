import { test, expect } from '@playwright/test'
import { setupMockAuth } from './helpers/auth'

test.describe('Session switch between chat and workspace', () => {
  const sessionId = 'switch-session'
  const sessionTitle = 'Switch Test'
  const userMessage = 'Hello from chat'

  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
    await page.addInitScript(({ id, title, message }) => {
      localStorage.setItem('xihe-token', 'mock-token')
      localStorage.setItem(
        'xihe-user',
        JSON.stringify({ id: 'user-1', email: 'test@xihe.local', name: 'Test User' }),
      )
      localStorage.setItem('xihe-sessions', JSON.stringify([
        { id, title, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]))
      localStorage.setItem('xihe-messages', JSON.stringify({
        [id]: [
          { id: 'msg-1', sessionId: id, role: 'user', content: message, timestamp: new Date().toISOString() },
        ],
      }))
    }, { id: sessionId, title: sessionTitle, message: userMessage })
  })

  test('chat and workspace share the same session messages', async ({ page }) => {
    await page.goto(`/chat/${sessionId}`)
    await expect(page.locator(`text=${userMessage}`)).toBeVisible({ timeout: 5000 })

    await page.locator('aside >> text=工作区').click()
    await page.waitForURL(`**/workspace/${sessionId}`)
    await expect(page.locator(`text=${userMessage}`)).toBeVisible({ timeout: 5000 })
    await expect(page.locator('button[title="Switch to chat"]')).toBeVisible({ timeout: 5000 })

    await page.locator('button[title="Switch to chat"]').click()
    await page.waitForURL(`**/chat/${sessionId}`)
    await expect(page.locator(`text=${userMessage}`)).toBeVisible({ timeout: 5000 })
  })

  test('workspace session selector switches session', async ({ page }) => {
    await page.addInitScript(() => {
      const sessions = [
        { id: 'switch-session', title: 'Switch Test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 'other-session', title: 'Other Session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]
      localStorage.setItem('xihe-sessions', JSON.stringify(sessions))
    })

    await page.goto(`/workspace/${sessionId}`)
    await expect(page.locator('button[title="Switch to chat"]')).toBeVisible({ timeout: 5000 })

    const select = page.locator('select')
    await select.selectOption('other-session')
    await page.waitForURL(`**/workspace/other-session`)
    await expect(page.locator('button[title="Switch to chat"]')).toBeVisible({ timeout: 5000 })
  })
})
