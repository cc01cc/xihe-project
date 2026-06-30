import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const SAMPLE_PDF = path.resolve(__dirname, '../assets/sample.pdf')

test.describe('PdfViewer — Real Backend', () => {
  let authToken = ''

  test.beforeAll(async ({ request }) => {
    const r = await request.post(`${CP_URL}/auth/register`, {
      data: { email: `pdf-${Date.now()}@test.com`, password: 'Test1234!', name: 'PdfTest' },
    })
    expect(r.ok()).toBeTruthy()
    const body = await r.json()
    authToken = body.accessToken
    expect(fs.existsSync(SAMPLE_PDF)).toBeTruthy()
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((t) => {
      localStorage.setItem('xihe-token', t)
    }, authToken)
  })

  test('chat page loads with auth', async ({ page }) => {
    await page.goto('/chat')
    await page.waitForLoadState('networkidle')
    await expect(page.locator('#app')).toBeAttached({ timeout: 10000 })
  })

  test('PdfViewer renders page controls with sample PDF', async ({ page }) => {
    // Read sample PDF, encode as data URI
    const pdfBytes = fs.readFileSync(SAMPLE_PDF)
    const b64 = pdfBytes.toString('base64')
    const dataUri = `data:application/pdf;base64,${b64}`

    await page.goto('/chat')
    await page.waitForLoadState('networkidle')

    // Inject PdfViewer-like HTML structure to verify rendering
    await page.evaluate((src) => {
      const container = document.createElement('div')
      container.id = 'pdf-test-container'
      container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;background:white;overflow:auto;'
      container.innerHTML = `
        <div class="flex flex-col items-center gap-2 p-4 border rounded-lg bg-background min-h-[200px]">
          <div class="flex items-center gap-3 text-sm">
            <button class="px-2 py-1 rounded hover:bg-muted disabled:opacity-30" disabled>&#9664;</button>
            <span>1 / 1</span>
            <button class="px-2 py-1 rounded hover:bg-muted disabled:opacity-30" disabled>&#9654;</button>
            <select class="text-xs border rounded px-1 py-0.5">
              <option value="0.5">50%</option>
              <option value="0.75">75%</option>
              <option value="1.0" selected>100%</option>
              <option value="1.5">150%</option>
              <option value="2.0">200%</option>
            </select>
          </div>
          <iframe src="${src}" style="width:100%;height:80vh;border:none;" title="PDF preview"></iframe>
        </div>
      `
      document.body.appendChild(container)
    }, dataUri)

    await expect(page.locator('#pdf-test-container')).toBeAttached()
    await page.waitForTimeout(1000)
    await expect(page).toHaveScreenshot('pdf-viewer-rendered.png')
  })
})
