import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const REAL_PDF = path.resolve(__dirname, '../assets/sample.pdf')

test.describe.configure({ retries: 2 })

test.describe('PdfViewer — Performance Benchmark', () => {
  let authToken = ''

  test.beforeAll(async ({ request }) => {
    expect(fs.existsSync(REAL_PDF)).toBeTruthy()
    const r = await request.post(`${CP_URL}/auth/register`, {
      data: { email: `perf-${Date.now()}@test.com`, password: 'Test1234!', name: 'PerfTest' },
    })
    expect(r.ok()).toBeTruthy()
    const body = await r.json()
    authToken = body.accessToken
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((t) => {
      localStorage.setItem('xihe-token', t)
    }, authToken)
    await page.goto('/chat')
    await page.waitForLoadState('load')
  })

  test('首页渲染 < 750ms (500ms × 1.5 tolerance)', async ({ page }) => {
    const b64 = fs.readFileSync(REAL_PDF).toString('base64')

    const renderTime = await page.evaluate(`(async () => {
      const pdfjsLib = await import('/node_modules/pdfjs-dist/build/pdf.min.mjs')
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
      const base64Data = ${JSON.stringify(b64)}
      const binary = atob(base64Data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

      const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise
      performance.mark('pdf-render-start')
      const page1 = await pdfDoc.getPage(1)
      const viewport = page1.getViewport({ scale: 1.0 })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      await page1.render({ canvasContext: ctx, viewport }).promise
      performance.mark('pdf-render-end')

      const measure = performance.measure('pdf-render', 'pdf-render-start', 'pdf-render-end')
      return measure.duration
    })()`)

    test.info().annotations.push({
      type: 'benchmark',
      description: `首页渲染耗时: ${renderTime.toFixed(1)}ms`,
    })
    expect(renderTime).toBeLessThan(750)
  })

  test('翻页延迟 < 300ms (200ms × 1.5 tolerance)', async ({ page }) => {
    const b64 = fs.readFileSync(REAL_PDF).toString('base64')

    const turnTime = await page.evaluate(`(async () => {
      const pdfjsLib = await import('/node_modules/pdfjs-dist/build/pdf.min.mjs')
      pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.min.mjs'
      const base64Data = ${JSON.stringify(b64)}
      const binary = atob(base64Data)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)

      const pdfDoc = await pdfjsLib.getDocument({ data: bytes }).promise
      const page1 = await pdfDoc.getPage(1)
      const viewport = page1.getViewport({ scale: 1.0 })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      await page1.render({ canvasContext: ctx, viewport }).promise

      performance.mark('page-turn-start')
      const page2 = await pdfDoc.getPage(2)
      const viewport2 = page2.getViewport({ scale: 1.0 })
      canvas.width = viewport2.width
      canvas.height = viewport2.height
      await page2.render({ canvasContext: ctx, viewport: viewport2 }).promise
      performance.mark('page-turn-end')

      const measure = performance.measure('page-turn', 'page-turn-start', 'page-turn-end')
      return measure.duration
    })()`)

    test.info().annotations.push({
      type: 'benchmark',
      description: `翻页延迟: ${turnTime.toFixed(1)}ms`,
    })
    expect(turnTime).toBeLessThan(300)
  })
})
