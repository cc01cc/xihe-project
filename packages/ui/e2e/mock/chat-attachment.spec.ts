import { test, expect } from '@playwright/test'
import { ChatPage } from '../page-objects/ChatPage'
import { setupMockAuth } from './helpers/auth'

const sessionId = 'attachment-session'

test.describe('Chat attachment persistence', () => {
  test('uploads attachment, merges with text, and persists after reload', async ({ page }) => {
    await setupMockAuth(page, { sse: { tokens: ['OK'] } })

    let messagesResponse: Array<Record<string, unknown>> = []

    await page.route(`**/api/v1/sessions/${sessionId}/attachments`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: [
            { id: 'file-1', name: 'note.txt', type: 'text/plain', size: 12, url: '/files/file-1' },
          ],
          failed: [],
        }),
      })
    })

    await page.route(`**/api/v1/sessions/${sessionId}/messages`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(messagesResponse),
      })
    })

    const chat = new ChatPage(page)
    await chat.goto(sessionId)
    await expect(chat.input).toBeVisible()

    await chat.attachFiles([
      { name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello world') },
    ])
    await expect(page.locator('[data-testid="selected-attachment"]')).toContainText('note.txt')

    await chat.input.fill('see attachment')
    await chat.sendButton.click()

    await expect(chat.uploadIndicator).toBeHidden()
    await expect(page.locator('text=see attachment')).toBeVisible()
    await expect(page.locator('[data-testid="message-attachment"]').filter({ hasText: 'note.txt' })).toBeVisible()

    messagesResponse = [
      {
        id: 'msg-1',
        sessionId,
        role: 'USER',
        content: 'see attachment',
        createdAt: new Date().toISOString(),
        attachments: [{ fileId: 'file-1', name: 'note.txt', type: 'text/plain', size: 12 }],
      },
      {
        id: 'msg-2',
        sessionId,
        role: 'ASSISTANT',
        content: 'OK',
        createdAt: new Date().toISOString(),
        attachments: [],
      },
    ]

    await page.reload()
    await expect(page.locator('text=see attachment')).toBeVisible()
    await expect(page.locator('[data-testid="message-attachment"]').filter({ hasText: 'note.txt' })).toBeVisible()
  })

  test('sends a pure attachment message when no text is entered', async ({ page }) => {
    await setupMockAuth(page, { sse: { tokens: ['Received'] } })

    await page.route(`**/api/v1/sessions/${sessionId}/attachments`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: [
            { id: 'file-2', name: 'image.png', type: 'image/png', size: 32, url: '/files/file-2' },
          ],
          failed: [],
        }),
      })
    })

    await page.route(`**/api/v1/sessions/${sessionId}/messages`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      })
    })

    const chat = new ChatPage(page)
    await chat.goto(sessionId)
    await chat.attachFiles([
      { name: 'image.png', mimeType: 'image/png', buffer: Buffer.from('fake-image') },
    ])
    await chat.sendButton.click()

    await expect(chat.uploadIndicator).toBeHidden()
    await expect(page.locator('[data-testid="message-attachment"]').filter({ hasText: 'image.png' })).toBeVisible()
  })
})
