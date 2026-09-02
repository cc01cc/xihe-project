import { test, expect } from '@playwright/test'
import { ChatPage } from '../page-objects/ChatPage'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

test.describe('Chat Scroller', () => {
  test.beforeEach(async ({ page }) => {
    await setupMockAuth(page)
  })

  test('scroll-to-bottom button appears when scrolled away from end', async ({ page }) => {
    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `msg-${i}`,
      sessionId: 'scroll-session',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}:\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10)}`,
      timestamp: new Date(Date.now() - (60 - i) * 60000).toISOString(),
    }))

    await setupMockSessions(page, {
      sessions: [{ id: 'scroll-session', title: 'Scroll Test' }],
      messages: { 'scroll-session': messages.map((message) => ({
        ...message,
        role: message.role.toUpperCase(),
        createdAt: message.timestamp,
      })) },
    })

    const chat = new ChatPage(page)
    await chat.goto('scroll-session')
    await expect(chat.scrollerViewport).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=Message 0')).toBeVisible({ timeout: 10000 })

    // Scroll to top to reveal the scroll-to-bottom button
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="message-scroller-viewport"]') as HTMLElement
      return el && el.scrollHeight > el.clientHeight
    }, { timeout: 10000 })
    await chat.scrollToTop()
    await page.waitForTimeout(500)

    const scrollableAttr = await chat.scrollerViewport.getAttribute('data-scrollable')
    expect(scrollableAttr).toContain('end')

    await chat.expectScrollerButtonActive()

    // Clicking the button scrolls back to the bottom and hides it
    await chat.clickScrollerButton()
    await page.waitForTimeout(300)

    await chat.expectScrollerButtonInactive()
  })

  test('auto-scrolls to bottom when a new message arrives', async ({ page }) => {
    await setupMockAuth(page, {
      sse: { tokens: ['This ', 'is ', 'a ', ' streamed ', 'reply.'] },
    })

    const messages = Array.from({ length: 50 }, (_, i) => ({
      id: `msg-${i}`,
      sessionId: 'auto-scroll-session',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i}:\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10)}`,
      timestamp: new Date(Date.now() - (50 - i) * 60000).toISOString(),
    }))

    await setupMockSessions(page, {
      sessions: [{ id: 'auto-scroll-session', title: 'Auto Scroll Test' }],
      messages: { 'auto-scroll-session': messages.map((message) => ({
        ...message,
        role: message.role.toUpperCase(),
        createdAt: message.timestamp,
      })) },
    })

    const chat = new ChatPage(page)
    await chat.goto('auto-scroll-session')
    await expect(chat.scrollerViewport).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=Message 0')).toBeVisible({ timeout: 10000 })
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="message-scroller-viewport"]') as HTMLElement
      return el && el.scrollHeight > el.clientHeight
    }, { timeout: 10000 })

    // Scroll to top first
    await chat.scrollToTop()
    await page.waitForTimeout(200)
    await chat.expectScrollerButtonActive()

    // Send a new message; auto-scroll should jump to bottom
    await chat.sendMessage('Keep going')
    await page.waitForTimeout(1000)

    await expect(chat.messageLocator('Keep going')).toBeVisible({ timeout: 10000 })
    await expect(chat.messageLocator('This is a streamed reply.')).toBeVisible({ timeout: 10000 })
  })
})
