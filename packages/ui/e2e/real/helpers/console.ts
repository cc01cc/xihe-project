import type { Page } from '@playwright/test'

/**
 * Collects browser-side errors for a Playwright page so specs can assert a clean console.
 * `pageerror` covers uncaught exceptions; `console` type `error` covers console.error and
 * browser-logged failed requests.
 */
export function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  return errors
}

/** Known non-actionable noise that must not mask real console errors. */
const IGNORED = [/favicon/i, /Download the Vue Devtools/i, /\[vite\]/i, /WebSocket connection/i]

export function actionableErrors(errors: string[]): string[] {
  return errors.filter((entry) => !IGNORED.some((pattern) => pattern.test(entry)))
}
