import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

test.describe('Cross-Module — Knowledge Base RAG', () => {
  test('knowledge settings page loads with correct heading', async ({ page }) => {
    const email = `rag-${Date.now()}@test.com`
    const reg = await fetch(`${CP_URL}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Test1234!', name: 'RAGTest' }),
    })
    const { accessToken } = await reg.json()

    await page.addInitScript((token) => {
      localStorage.setItem('xihe-token', token)
    }, accessToken)

    await page.goto('/settings/knowledge')
    await expect(page.getByRole('heading', { name: /知识库|Knowledge/i })).toBeVisible({ timeout: 10000 })
    expect(page.url()).toContain('/settings/knowledge')
  })
})
