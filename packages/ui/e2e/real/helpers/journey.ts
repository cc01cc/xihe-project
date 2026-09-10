// Shared helpers for journey-* Host specs (PLAN-294 ②3 extraction).
// The journey specs previously duplicated registration, page seeding, chat
// send, and terminal-state polling; this module is their single source.
import path from 'node:path'
import { generateE2EPassword } from './password'
import { expect } from '@playwright/test'

export const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`

export function evidenceDir(name: string): string {
  return path.resolve(process.cwd(), '../../.local/evidence', name)
}

export interface JourneyContext {
  authToken: string
  workspaceId: string
  headers: Record<string, string>
}

/** Register a fresh user (one per spec — the Agent binds one workspace per process). */
export async function registerJourneyUser(request: import('@playwright/test').APIRequestContext, name: string): Promise<JourneyContext> {
  const password = process.env.XIHE_E2E_PASSWORD ?? generateE2EPassword()
  const reg = await request.post(`${CP_URL}/api/v1/auth/register`, {
    data: { email: `${name}-${Date.now()}@test.com`, password, name },
  })
  expect([200, 201], `register failed: ${reg.status()} ${await reg.text()}`).toContain(reg.status())
  const auth = await reg.json() as { accessToken: string; workspaceId: string }
  return {
    authToken: auth.accessToken,
    workspaceId: auth.workspaceId,
    headers: { Authorization: `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
  }
}

/** Seed localStorage with auth/workspace so the SPA boots straight into the workspace. */
export function seedPage(page: import('@playwright/test').Page, ctx: JourneyContext): void {
  page.addInitScript((t) => localStorage.setItem('xihe-token', t), ctx.authToken)
  page.addInitScript((raw) => localStorage.setItem('xihe-user', raw), JSON.stringify({ workspaceId: ctx.workspaceId }))
  page.addInitScript((ws) => localStorage.setItem('xihe-workspace', JSON.stringify(ws)), { id: ctx.workspaceId, name: 'Default Workspace' })
}

/**
 * Send a chat message with the two known robustness hazards handled:
 *  - 新建对话 switches sessions asynchronously and clears the input — retry
 *    the fill until the send button reflects the non-empty input;
 *  - a click before the SSE stream component hydrates returns null from
 *    sendMessage and never POSTs (PLAN-294 M1) — retry until the optimistic
 *    user bubble appears.
 */
export async function sendChat(page: import('@playwright/test').Page, text: string): Promise<void> {
  const input = page.locator('[data-testid="chat-input"]')
  const send = page.locator('[data-testid="chat-send-button"]')
  for (let i = 0; i < 6; i++) {
    await input.fill(text)
    if (await send.isEnabled().catch(() => false)) break
    await page.waitForTimeout(1000)
  }
  await expect(send).toBeEnabled({ timeout: 15000 })
  for (let i = 0; i < 10; i++) {
    await send.click()
    try {
      await expect(
        page.locator('[data-slot="message"][data-align="end"]').first(),
      ).toBeVisible({ timeout: 3000 })
      return
    } catch {
      await page.waitForTimeout(1000)
    }
  }
  throw new Error('send never produced a user message bubble')
}

/** Wait until the session's latest operation reaches a terminal state. */
export async function awaitLastOperationCompleted(
  request: import('@playwright/test').APIRequestContext,
  headers: Record<string, string>,
): Promise<void> {
  await expect.poll(async () => {
    const res = await request.get(`${CP_URL}/api/v1/operations?size=1`, { headers })
    const body = (await res.json()) as { operations?: Array<{ status?: string }> }
    return body.operations?.[0]?.status ?? 'unknown'
  }, { timeout: 120000, intervals: [2_000] }).toBe('completed')
}

/**
 * Recover from the brand-new-user empty state ("暂无活动会话"): auto session
 * creation can race CP readiness on cold starts, so 新建对话 is the real
 * user path out of it.
 */
export async function ensureChatReady(page: import('@playwright/test').Page): Promise<void> {
  const chatInput = page.locator('[data-testid="chat-input"]')
  if (!(await chatInput.isVisible({ timeout: 10000 }).catch(() => false))) {
    const newChat = page.getByRole('button', { name: '新建对话' }).first()
    if (await newChat.isVisible().catch(() => false)) {
      await newChat.click()
    } else {
      await page.reload({ waitUntil: 'load' })
    }
  }
  await expect(chatInput, 'chat input visible on workspace page').toBeVisible({ timeout: 30000 })
}
