import { test, expect } from '@playwright/test'

const DOCS = [
  { id: 'doc-1', filename: 'requirements.pdf', chunks: 5 },
  { id: 'doc-2', filename: 'architecture.md', chunks: 12 },
  { id: 'doc-3', filename: 'notes.txt', chunks: 3 },
]

test.describe('Knowledge Base', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('xihe-token', 'mock-token')
    })
  })

  test('shows empty state with drop zone', async ({ page }) => {
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }))
    await page.route('**/api/v1/events**', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
    await page.route('**/api/v1/rag/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: [] }) }))
    await page.goto('/settings/knowledge', { waitUntil: 'load' })
    await page.waitForTimeout(1500)
    await expect(page.locator('text=暂无文档')).toBeVisible()
    await expect(page).toHaveScreenshot('knowledge-empty.png')
  })

  test('shows error state with retry button', async ({ page }) => {
    await page.route('**/api/v1/events**', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }))
    await page.route('**/api/v1/rag/stats', (route) => route.fulfill({ status: 500, body: 'Server error' }))
    await page.goto('/settings/knowledge', { waitUntil: 'load' })
    await page.waitForTimeout(1000)
    await expect(page.locator('text=Retry')).toBeVisible()
    await expect(page).toHaveScreenshot('knowledge-error.png')
  })

  test('shows loading state', async ({ page }) => {
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }))
    await page.route('**/api/v1/events**', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
    await page.route('**/api/v1/rag/stats', async (route) => {
      await new Promise(r => setTimeout(r, 2000))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: [] }) })
    })
    await page.goto('/settings/knowledge', { waitUntil: 'load' })
    await expect(page.locator('text=Loading documents')).toBeVisible()
    await expect(page).toHaveScreenshot('knowledge-loading.png')
  })

  test('lists documents with delete button', async ({ page }) => {
    await page.route('**/api/v1/events**', (route) => route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'retry: 5000\n\n' }))
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }))
    await page.route('**/api/v1/rag/stats', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ documents: DOCS }) }))
    await page.goto('/settings/knowledge', { waitUntil: 'load' })
    await page.waitForTimeout(1500)
    await expect(page.locator('text=requirements.pdf')).toBeVisible()
    await expect(page.locator('text=architecture.md')).toBeVisible()
    await expect(page.locator('text=notes.txt')).toBeVisible()
    await expect(page.locator('button:has-text("删除")')).toHaveCount(3)
    await expect(page).toHaveScreenshot('knowledge-documents.png')
  })
})
