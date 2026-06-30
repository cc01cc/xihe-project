import { test, expect } from '@playwright/test'
import { setupMockAuth } from './helpers/auth'

function markdownResponseTokens(): string[] {
  return [
    'Here ',
    'is ',
    'a ',
    'list:\n\n',
    '- ',
    'first item\n',
    '- ',
    'second item\n\n',
    'And ',
    'some ',
    'code:\n\n',
    '```ts\n',
    'const x = 1\n',
    'const y = 2\n',
    '```',
  ]
}

test.describe('Chat', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
  })

  test('empty chat page renders correctly', async ({ page }) => {
    await page.goto('/chat/test-session')
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5000 })
    await expect(page).toHaveScreenshot('chat-empty.png')
  })

  test('renders pre-existing messages from localStorage', async ({ page }) => {
    await page.addInitScript(() => {
      const messages = {
        'test-session': [
          { id: 'msg-1', sessionId: 'test-session', role: 'user', content: 'What is TypeScript?', timestamp: new Date(Date.now() - 60000).toISOString() },
          { id: 'msg-2', sessionId: 'test-session', role: 'assistant', content: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.', timestamp: new Date().toISOString() },
        ],
      }
      localStorage.setItem('xihe-messages', JSON.stringify(messages))
      localStorage.setItem('xihe-sessions', JSON.stringify([
        { id: 'test-session', title: 'Chat about TS', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]))
    })

    await page.goto('/chat/test-session')
    await expect(page.locator('text=What is TypeScript?')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=TypeScript is a typed superset of JavaScript')).toBeVisible({ timeout: 5000 })
    await expect(page).toHaveScreenshot('chat-with-messages.png')
  })

  test('shows session in sidebar after creating new chat', async ({ page }) => {
    await page.goto('/chat')

    const newChatBtn = page.locator('button:has-text("新建对话")')
    await newChatBtn.click()

    const sessionItem = page.locator('[class*="group"]').first()
    await expect(sessionItem).toBeVisible({ timeout: 5000 })
  })

  test('shows sidebar with seeded sessions', async ({ page }) => {
    await page.addInitScript(() => {
      const sessions = [
        { id: 'sid-1', title: 'TypeScript Help', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        { id: 'sid-2', title: 'Rust Borrow Checker', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      ]
      localStorage.setItem('xihe-sessions', JSON.stringify(sessions))
    })

    await page.goto('/chat/sid-1')

    await expect(page.locator('aside >> text=TypeScript Help')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('aside >> text=Rust Borrow Checker')).toBeVisible({ timeout: 5000 })
    await expect(page).toHaveScreenshot('chat-with-sessions.png')
  })

  test('empty state in sidebar when no sessions', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-sessions', JSON.stringify([]))
    })

    await page.goto('/chat/default')
    await expect(page.locator('text=暂无对话')).toBeVisible({ timeout: 5000 })
    await expect(page).toHaveScreenshot('chat-sidebar-empty.png')
  })

  test('sends message and streams markdown response', async ({ page }) => {
    await setupMockAuth(page, { sse: { tokens: markdownResponseTokens() } })

    await page.goto('/chat/stream-session')

    const textarea = page.locator('textarea')
    await textarea.fill('Show me markdown')
    await textarea.press('Enter')

    await expect(page.locator('text=Show me markdown')).toBeVisible({ timeout: 5000 })

    await expect(page.locator('text=Here is a list:')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=first item')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=second item')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=const x = 1')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('text=const y = 2')).toBeVisible({ timeout: 10000 })

    const codeBlock = page.locator('pre code:has-text("const x = 1")')
    await expect(codeBlock).toBeVisible({ timeout: 10000 })

    await expect(page).toHaveScreenshot('chat-streaming-markdown.png')
  })

  test('stops streaming on user request', async ({ page }) => {
    await setupMockAuth(page, {
      sse: {
        tokens: ['first ', 'second ', 'third ', 'fourth ', 'fifth'],
        delayMs: 200,
      },
    })

    await page.goto('/chat/stop-session')

    const textarea = page.locator('textarea')
    await textarea.fill('Keep going')
    await textarea.press('Enter')

    const stopButton = page.locator('button[aria-label="chat.stop"], button[aria-label="停止生成"]')
    await expect(stopButton).toBeVisible({ timeout: 5000 })

    await stopButton.click()

    await expect(page.locator('button[aria-label="chat.send"], button[aria-label="发送"]')).toBeVisible({ timeout: 5000 })
  })
})
