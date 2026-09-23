import { type Page } from '@playwright/test'

/**
 * Workspace-first landing never auto-creates a Session (PLAN-0328 M3 T3.7).
 * Tests that need a live composer must create one through the visible affordance:
 * - desktop: the no-session empty-state CTA, or the sidebar button
 * - mobile (conversation column unmounted): the MobileChatSheet FAB, which only
 *   exists once a Session is selected — seed one via the API in beforeAll
 *
 * All waits are event-driven; race losers resolve (not reject) to avoid
 * unhandled rejections after the race settles.
 */
export async function ensureWorkspaceChat(page: Page): Promise<void> {
  const textarea = page.locator('textarea')
  const emptyStateCta = page.getByTestId('workspace-create-session')
  const chatFab = page.getByRole('button', { name: 'Open chat' })
  const sidebarNew = page.getByTestId('sidebar-new-chat')

  const pick = (locator: typeof textarea, tag: string) =>
    locator.waitFor({ state: 'visible', timeout: 10000 }).then(() => tag).catch(() => null)
  const ready = await Promise.race([
    pick(textarea, 'chat'),
    pick(emptyStateCta, 'cta'),
    pick(chatFab, 'fab'),
  ])

  if (ready === 'chat') return
  if (ready === 'cta') {
    await emptyStateCta.click()
  } else if (ready === 'fab') {
    await chatFab.click()
  } else {
    await sidebarNew.waitFor({ state: 'visible', timeout: 5000 })
    await sidebarNew.click()
  }
  await textarea.waitFor({ state: 'visible', timeout: 10000 })
}

export async function gotoWorkspaceWithChat(page: Page): Promise<void> {
  await page.goto('/workspace', { waitUntil: 'load' })
  await ensureWorkspaceChat(page)
}
