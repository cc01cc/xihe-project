import { test, expect } from '@playwright/test'
import { setupMockAuth, setupMockSessions } from './helpers/auth'

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

  test('renders pre-existing messages from the server projection', async ({ page }) => {
    await setupMockSessions(page, {
      sessions: [{ id: 'test-session', title: 'Chat about TS' }],
      messages: {
        'test-session': [
          { id: 'msg-1', sessionId: 'test-session', role: 'USER', content: 'What is TypeScript?', createdAt: new Date(Date.now() - 60000).toISOString() },
          { id: 'msg-2', sessionId: 'test-session', role: 'ASSISTANT', content: 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.', createdAt: new Date().toISOString() },
        ],
      },
    })

    await page.goto('/chat/test-session')
    await expect(page.locator('text=What is TypeScript?')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('text=TypeScript is a typed superset of JavaScript')).toBeVisible({ timeout: 5000 })
    await expect(page).toHaveScreenshot('chat-with-messages.png')
  })

  test('shows session in sidebar after creating new chat', async ({ page }) => {
    await setupMockSessions(page, { createSession: true })
    await page.goto('/chat')

    const newChatBtn = page.locator('button:has-text("新建对话")')
    await newChatBtn.click()

    const sessionItem = page.locator('[class*="group"]').first()
    await expect(sessionItem).toBeVisible({ timeout: 5000 })
  })

  test('shows sidebar with server sessions', async ({ page }) => {
    await setupMockSessions(page, {
      sessions: [
        { id: 'sid-1', title: 'TypeScript Help' },
        { id: 'sid-2', title: 'Rust Borrow Checker' },
      ],
    })

    await page.goto('/chat/sid-1')

    await expect(page.locator('aside >> text=TypeScript Help')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('aside >> text=Rust Borrow Checker')).toBeVisible({ timeout: 5000 })
    await expect(page).toHaveScreenshot('chat-with-sessions.png')
  })

  test('empty state in sidebar when no sessions', async ({ page }) => {
    await setupMockSessions(page)

    await page.goto('/chat/default')
    await expect(page.locator('text=暂无对话')).toBeVisible({ timeout: 5000 })
    await expect(page).toHaveScreenshot('chat-sidebar-empty.png')
  })

  test('sends message and streams markdown response', async ({ page }) => {
    await setupMockAuth(page, { sse: { tokens: markdownResponseTokens() } })
    await setupMockSessions(page, { sessions: [{ id: 'stream-session', title: 'Stream Test' }] })

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

    const codeBlock = page.locator('pre:has-text("const x = 1")').first()
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
    await setupMockSessions(page, { sessions: [{ id: 'stop-session', title: 'Stop Test' }] })

    await page.goto('/chat/stop-session')

    const textarea = page.locator('textarea')
    await textarea.fill('Keep going')
    await textarea.press('Enter')

    const stopButton = page.locator('button[aria-label="chat.stop"], button[aria-label="停止生成"]')
    await expect(stopButton).toBeVisible({ timeout: 5000 })

    await stopButton.click()

    await expect(page.locator('button[aria-label="chat.send"], button[aria-label="发送"]')).toBeVisible({ timeout: 5000 })
  })

  test('shows a retryable stream error and recovers through retry', async ({ page }) => {
    await setupMockAuth(page, {
      sse: {
        tokens: ['partial response'],
        retryTokens: ['recovered response'],
        errorAfterTokens: {
          code: 'PROVIDER_TEMPORARY',
          detail: 'Provider temporarily unavailable',
          retryable: true,
        },
        delayMs: 50,
      },
    })
    await setupMockSessions(page, { sessions: [{ id: 'retry-session', title: 'Retry Test' }] })

    await page.goto('/chat/retry-session')
    const textarea = page.locator('textarea')
    await textarea.fill('Try again')
    await textarea.press('Enter')

    await expect(page.getByText('partial response')).toBeVisible({ timeout: 10000 })
    await expect(page.getByTestId('message-error')).toContainText('PROVIDER_TEMPORARY')
    const retry = page.getByTestId('message-retry-button')
    await expect(retry).toBeVisible()
    await retry.click()
    await expect(page.getByText('recovered response')).toBeVisible({ timeout: 10000 })
    await expect(page).toHaveScreenshot('chat-retry-recovered.png')
  })

  test('voice input appends a final transcript to the composer', async ({ page }) => {
    await page.addInitScript(() => {
      class MockSpeechRecognition {
        static instance: MockSpeechRecognition | null = null
        onresult: ((event: unknown) => void) | null = null
        onend: (() => void) | null = null
        onerror: ((event: unknown) => void) | null = null

        constructor() {
          MockSpeechRecognition.instance = this
        }

        start() {}
        stop() { this.onend?.() }
      }
      Object.defineProperty(window, 'SpeechRecognition', {
        configurable: true,
        value: MockSpeechRecognition,
      })
    })
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'voice-session', title: 'Voice Test' }] })

    await page.goto('/chat/voice-session')
    const voiceButton = page.getByTitle('语音输入')
    await expect(voiceButton).toBeVisible()
    await voiceButton.click()
    await page.evaluate(() => {
      const recognition = (window as typeof window & {
        SpeechRecognition: { instance?: { onresult?: (event: unknown) => void } }
      }).SpeechRecognition.instance
      recognition?.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: '来自语音' } }],
      })
    })
    await expect(page.getByTestId('chat-input')).toHaveValue('来自语音')
    await expect(page).toHaveScreenshot('chat-voice-transcript.png')
  })

  test('attachment upload failure keeps the draft and shows a toast', async ({ page }, testInfo) => {
    await setupMockAuth(page)
    await setupMockSessions(page, { sessions: [{ id: 'upload-failure-session', title: 'Upload Failure' }] })
    await page.route('**/api/v1/sessions/upload-failure-session/attachments', (route) => route.fulfill({
      status: 500,
      contentType: 'application/problem+json',
      body: JSON.stringify({ code: 'ATTACHMENT_UPLOAD_FAILED', detail: 'Attachment service unavailable' }),
    }))

    await page.goto('/chat/upload-failure-session')
    await page.getByTestId('file-upload-input').setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Notes'),
    })
    await page.getByTestId('chat-input').fill('Keep this draft')
    await page.getByTestId('chat-input').press('Enter')
    await expect(page.getByTestId('chat-input')).toHaveValue('Keep this draft')
    await expect(page.getByTestId('attachment-upload-error')).toBeVisible()
    await expect(page.getByTestId('attachment-retry-button')).toBeVisible()
    await expect(page.getByTestId('attachment-error-remove-button')).toBeVisible()
    await expect(page.locator('[data-sonner-toast]')).toContainText('Attachment service unavailable')
    await page.screenshot({ path: testInfo.outputPath('plan-269-attachment-failure-full.png') })
    await expect(page).toHaveScreenshot('chat-attachment-upload-failure.png')
  })

  test('new user message is marked as scroll anchor', async ({ page }) => {
    await setupMockAuth(page, {
      sse: { tokens: ['reply '] },
    })
    await setupMockSessions(page, { sessions: [{ id: 'anchor-session', title: 'Anchor Test' }] })

    await page.goto('/chat/anchor-session')

    const textarea = page.locator('textarea')
    await textarea.fill('Anchor me')
    await textarea.press('Enter')

    await expect(page.locator('[data-slot="message-scroller-item"][data-scroll-anchor="true"]')).toBeVisible({ timeout: 5000 })
  })
})
