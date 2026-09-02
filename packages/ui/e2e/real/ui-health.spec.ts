import { generateE2EPassword } from './helpers/password'

const SHARED_PASSWORD = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
import { test, expect } from '@playwright/test'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

interface HealthPage {
  path: string
  name: string
  requiresAuth: boolean
  keySelector: string | null
  benign: string[]
  hostOnly?: boolean
}

const pages: HealthPage[] = [
  { path: '/chat', name: 'chat', requiresAuth: true, keySelector: 'textarea', benign: [] as string[] },
  { path: '/settings/config', name: 'settings-config', requiresAuth: true, keySelector: '[data-testid="settings-config-heading"]', benign: [] as string[] },
  { path: '/settings/knowledge', name: 'settings-knowledge', requiresAuth: true, keySelector: '[data-testid="settings-knowledge-heading"]', benign: ['status of 502'] },
  { path: '/settings/data', name: 'settings-data', requiresAuth: true, keySelector: '[data-testid="settings-data-heading"]', benign: [] as string[] },
  { path: '/settings/monitoring', name: 'settings-monitoring', requiresAuth: true, keySelector: '[data-testid="settings-monitoring-heading"]', benign: [] as string[] },
  { path: '/workspace', name: 'workspace', requiresAuth: true, keySelector: null, benign: [] as string[], hostOnly: true },
  { path: '/login', name: 'login', requiresAuth: false, keySelector: 'input[type="password"]', benign: [] as string[] },
  { path: '/register', name: 'register', requiresAuth: false, keySelector: 'input[type="password"]', benign: [] as string[] },
]

test.describe('UI Health — Console, Overflow, Hit-Test', () => {
  let authToken = ''
  let workspaceId = ''

  test.beforeAll(async ({ request }) => {
    const r = await request.post(`${CP_URL}/api/v1/auth/register`, {
      data: { email: `health-${Date.now()}@test.com`, password: SHARED_PASSWORD, name: 'Health' },
    })
    const auth = await r.json()
    authToken = auth.accessToken
    workspaceId = auth.workspaceId
  })

  for (const p of pages) {
    test(`${p.hostOnly ? '@host ' : ''}${p.name}: zero console errors, zero pageerrors, no horizontal overflow`, async ({ page }) => {
      const consoleErrors: string[] = []
      const pageErrors: string[] = []
      const failedResponses: string[] = []
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()) })
      page.on('pageerror', (err) => pageErrors.push(String(err)))
      page.on('response', (res) => { if (res.status() >= 400) failedResponses.push(`${res.status()} ${res.url()}`) })

      if (p.requiresAuth) {
        await page.addInitScript(({ token, wsId }) => {
          localStorage.setItem('xihe-token', token)
          localStorage.setItem('xihe-user', JSON.stringify({ workspaceId: wsId }))
        }, { token: authToken, wsId: workspaceId })
      }
      const resp = await page.goto(p.path, { waitUntil: 'load', timeout: 15000 })
      expect(resp?.status()).toBe(200)
      if (p.keySelector) {
        await page.locator(p.keySelector).first().waitFor({ state: 'visible', timeout: 10000 })
      }
      await page.waitForTimeout(1500)

      expect(pageErrors, `pageerrors on ${p.path}: ${pageErrors.join('; ')}`).toHaveLength(0)

      const benign = consoleErrors.filter((e) =>
        !e.includes('favicon') && !e.includes('net::ERR_ABORTED') && !e.includes('404') &&
        !p.benign.some((b) => e.includes(b)),
      )
      expect(benign, `console errors on ${p.path}: ${benign.join('; ')} | failed responses: ${failedResponses.join('; ')}`).toHaveLength(0)

      const overflow = await page.evaluate(() => {
        const doc = document.scrollingElement
        return doc ? doc.scrollWidth - doc.clientWidth : 0
      })
      expect(overflow, `horizontal overflow on ${p.path}: ${overflow}px`).toBeLessThanOrEqual(2)
    })
  }

  test('chat key controls are clickable via elementFromPoint hit-test', async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('xihe-token', t), authToken)
    await page.goto('/chat', { waitUntil: 'load' })
    await page.locator('textarea').waitFor({ state: 'visible', timeout: 10000 })

    const targets = [
      { name: 'send textarea', locator: page.locator('textarea') },
      { name: 'new session button', locator: page.locator('button').filter({ hasText: /new|新建/i }).first() },
    ]
    for (const t of targets) {
      if (await t.locator.count() === 0) continue
      const hit = await t.locator.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
        return top === el || el.contains(top)
      })
      expect(hit, `${t.name} is covered by another element`).toBe(true)
    }
  })
})

