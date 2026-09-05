import { defineConfig } from '@playwright/test'

const UI_PORT = process.env.XIHE_UI_PORT || '12630'
const externalServer = process.env.XIHE_E2E_EXTERNAL_SERVER === '1'
const e2eProfile = process.env.XIHE_E2E_PROFILE || 'all'
const headed = process.env.XIHE_E2E_HEADED === '1'
const browserChannel = process.env.XIHE_E2E_BROWSER_CHANNEL

export default defineConfig({
  testDir: '..',
  testMatch: ['e2e/mock/*.spec.ts', 'e2e/real/*.spec.ts'],
  timeout: 30000,
  retries: 1,
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    headless: !headed,
    ...(browserChannel ? { channel: browserChannel } : {}),
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
  grep: e2eProfile === 'host' ? /@host/ : undefined,
  grepInvert: e2eProfile === 'compose' ? /@host/ : undefined,
  webServer: externalServer
    ? undefined
    : {
        command: 'pnpm dev',
        port: Number(UI_PORT),
        timeout: 120000,
        reuseExistingServer: true,
      },
})
