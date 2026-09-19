// Shared helpers for journey-* Host specs (PLAN-294 ②3 extraction).
// The journey specs previously duplicated registration, page seeding, chat
// send, and terminal-state polling; this module is their single source.
import { execSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
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

// ── PLAN-0369: Agent workspace binding ──────────────────────────────────────
// The Agent process owns exactly ONE MCP workspace context (`main.py`
// `_get_mcp_tools`: a different workspace raises "MCP workspace context cannot
// be reused across workspaces"). That is product design (LIF-2 single
// binding) — switching workspaces requires restarting the Agent process, as
// documented in A03-xihe/AGENTS.md. Specs that chat from a workspace page
// call `ensureAgentWorkspaceBinding(<their workspace>)` before the first send
// so a full @host run can move between spec-local workspaces.
const AGENT_PORT = Number(process.env.XIHE_AGENT_PORT || '12632')
const CP_PORT = Number(process.env.XIHE_CP_PORT || '12631')
const HOST_ROOT = path.resolve(
  process.cwd(),
  '../../.tmp/e2e-host',
  process.env.XIHE_E2E_RUN_ID ?? 'unknown-run',
)
const AGENT_DIR = path.resolve(process.cwd(), '../agent')
const BINDING_STATE_FILE = path.join(HOST_ROOT, 'agent-binding.json')

function listeningPid(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
      const line = out
        .split(/\r?\n/)
        .find((entry) => entry.includes(`:${port} `) && entry.includes('LISTENING'))
      const pid = line?.trim().split(/\s+/).pop()
      return pid ? Number(pid) : null
    }
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' })
    return out.trim() ? Number(out.trim().split(/\s+/)[0]) : null
  } catch {
    return null
  }
}

function killPidTree(pid: number): void {
  if (process.platform === 'win32') {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
  } else {
    process.kill(pid, 'SIGTERM')
  }
}

async function agentHealthOk(): Promise<{ ok: boolean; llmReady: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const response = await fetch(`http://127.0.0.1:${AGENT_PORT}/internal/v1/agent/health`, {
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, llmReady: 'unknown' }
    const body = (await response.json()) as { llmReady?: string }
    return { ok: true, llmReady: body.llmReady ?? 'unknown' }
  } catch {
    return { ok: false, llmReady: 'unknown' }
  } finally {
    clearTimeout(timer)
  }
}

function readBindingWorkspace(): string | null {
  try {
    return (JSON.parse(readFileSync(BINDING_STATE_FILE, 'utf8')) as { workspaceId?: string }).workspaceId ?? null
  } catch {
    return null
  }
}

/**
 * Restart the isolated Agent so its MCP context belongs to `workspaceId`.
 * No-op when the recorded binding already matches, or when the runner did not
 * inject `XIHE_E2E_AGENT_RESTART_ENV` (compose/dev stacks: one dedicated
 * workspace per process is then the caller's responsibility).
 */
export async function ensureAgentWorkspaceBinding(workspaceId: string): Promise<void> {
  if (!workspaceId) return
  const rawContract = process.env.XIHE_E2E_AGENT_RESTART_ENV
  if (!rawContract) {
    console.warn(
      '[journey] ensureAgentWorkspaceBinding skipped: no XIHE_E2E_AGENT_RESTART_ENV (not launched via scripts/e2e-host.mjs); the Agent must stay bound to one workspace',
    )
    return
  }
  const contract = JSON.parse(rawContract) as Record<string, string> & { disabled?: string }
  if (contract.disabled) {
    console.warn(
      `[journey] ensureAgentWorkspaceBinding disabled (${contract.disabled}); single-workspace behavior unchanged`,
    )
    return
  }
  if (readBindingWorkspace() === workspaceId) return

  const previousPid = listeningPid(AGENT_PORT)
  if (previousPid !== null) {
    killPidTree(previousPid)
    await expect
      .poll(async () => (await agentHealthOk()).ok, {
        message: 'Agent must stop answering before the workspace rebind restart',
        timeout: 20000,
        intervals: [500, 1000, 2000],
      })
      .toBe(false)
  }

  const logFile = path.join(HOST_ROOT, 'logs', `agent-rebind-${Date.now()}.log`)
  mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = openSync(logFile, 'a')
  try {
    const child = spawn(process.platform === 'win32' ? 'uv.exe' : 'uv', ['run', 'python', '-m', 'xihe_agent.main'], {
      cwd: AGENT_DIR,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        XIHE_ENV: 'dev',
        XIHE_AGENT_PORT: String(AGENT_PORT),
        XIHE_CP_URL: `http://127.0.0.1:${CP_PORT}`,
        XIHE_CP_API_TOKEN: process.env.XIHE_CP_API_TOKEN ?? '',
        XIHE_AGENT_API_TOKEN: process.env.XIHE_CP_API_TOKEN ?? '',
        XIHE_E2E_RUN_ID: process.env.XIHE_E2E_RUN_ID ?? '',
        XIHE_LOG_DIR: path.join(HOST_ROOT, 'logs'),
        XIHE_LOAD_DOTENV: '0',
        ...contract,
      } as Record<string, string>,
    })
    child.unref()
  } finally {
    closeSync(fd)
  }
  console.log(`[journey] Agent restarted for workspace ${workspaceId} (log: ${logFile})`)

  const deadline = Date.now() + 180000
  let lastState = 'not ready'
  while (Date.now() < deadline) {
    const health = await agentHealthOk()
    if (health.ok && health.llmReady === 'ready') {
      writeFileSync(
        BINDING_STATE_FILE,
        JSON.stringify({ workspaceId, restartedAt: new Date().toISOString() }, null, 2),
      )
      return
    }
    lastState = health.ok ? `llmReady=${health.llmReady}` : 'health unreachable'
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(`Agent did not become ready within 180000ms (${lastState})`)
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
  // Each retry re-fills: a stale Vue mount (session switch / remount after
  // ensureChatReady) can drop the earlier input event, leaving the button
  // disabled with DOM value set but no v-model update.
  for (let i = 0; i < 6; i++) {
    await input.click().catch(() => {})
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
