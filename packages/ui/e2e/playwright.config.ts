import { defineConfig } from '@playwright/test'

const UI_PORT = process.env.XIHE_UI_PORT || '12630'

export default defineConfig({
  testDir: '.',
  testMatch: ['mock/*.spec.ts', 'real/*.spec.ts'],
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    headless: true,
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      threshold: 0.2,
      maxDiffPixelRatio: 0.01,
    },
  },
  webServer: {
    command: 'pnpm dev',
    port: Number(UI_PORT),
    timeout: 120000,
    reuseExistingServer: true,
  },
})
