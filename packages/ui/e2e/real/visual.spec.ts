import { test, chromium, expect } from '@playwright/test'

const UI_PORT = process.env.XIHE_UI_PORT || '12630'

test('register page 2x visual snapshot', async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.goto(`http://localhost:${UI_PORT}/register`, { waitUntil: 'networkidle' })
  await page.waitForSelector('h1', { timeout: 10000 })
  const dpr = await page.evaluate(() => window.devicePixelRatio)
  console.log('DPR:', dpr)
  await expect(page).toHaveScreenshot('register-page-2x.png')
  await ctx.close()
  await browser.close()
})
