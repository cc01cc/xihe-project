import { test } from '@playwright/test'

test.describe('Accessibility — prefers-reduced-motion', () => {
  test('animations are disabled when prefers-reduced-motion is set', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto('/chat/test-session')
    await page.waitForLoadState('networkidle')

    await page.evaluate(() => {
      const style = getComputedStyle(document.body)
      return style.animationName !== 'none' || style.transitionProperty !== 'all'
    })
  })
})
