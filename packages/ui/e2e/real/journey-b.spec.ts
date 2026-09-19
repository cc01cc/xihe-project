// PLAN-0353 D1 (Q1-A): journey-b evidence — manual workspace mutations.
// B1: human-readable error while Runtime is down, then recovery after restart;
// B2: the user-direct UI mutation lands in the Operation Ledger as actorType=user.
//
// Host profile only. Run via:
//   node scripts/e2e-host.mjs --retries=0 e2e/real/journey-b.spec.ts
// The spec kills the isolated Runtime process itself and restarts it in
// B1-recover. PLAN-0369: the restarted process is intentionally LEFT RUNNING so
// the remaining specs in a full @host run keep a working Runtime (the previous
// afterAll kill cascaded into every later Runtime-dependent spec); the isolated
// runner reaps it by port during teardown. On a dev stack, restart the runtime
// afterwards with `mise run dev:runtime`.
import { execSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync } from 'node:fs'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { registerJourneyUser, seedPage, type JourneyContext } from './helpers/journey'

const CP_URL = `http://localhost:${process.env.XIHE_CP_PORT || '12631'}`
const RUNTIME_PORT = Number(process.env.XIHE_RUNTIME_PORT || '12633')
const RUNTIME_DIR = path.resolve(process.cwd(), '../runtime')
const RUNTIME_EXE = path.join(
  RUNTIME_DIR,
  'target',
  'debug',
  process.platform === 'win32' ? 'xihe-runtime.exe' : 'xihe-runtime',
)
const HOST_ROOT = path.resolve(
  process.cwd(),
  '../../.tmp/e2e-host',
  process.env.XIHE_E2E_RUN_ID ?? 'unknown-run',
)
// PLAN-0369: evidence lands in the current PLAN, never in an archived one —
// pointing at plans/archive made every full run rewrite frozen归档 PNGs.
const EVIDENCE_DIR = path.resolve(
  process.cwd(),
  '../../../plans/PLAN-0369-XH-host-e2e-harness-closure/evidence',
)
const HUMAN_RUNTIME_DOWN = '沙盒未就绪'

let ctx: JourneyContext

function evidencePath(name: string): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  return path.join(EVIDENCE_DIR, name)
}

function listeningPid(port: number): number | null {
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p tcp', { encoding: 'utf8' })
      const line = out
        .split(/\r?\n/)
        .find((l) => l.includes(`:${port} `) && l.includes('LISTENING'))
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

async function fetchOk(url: string, timeoutMs = 2000): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitForHttp(url: string, timeoutMs = 120000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fetchOk(url)) return
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`${url} not ready within ${timeoutMs}ms`)
}

async function killRuntime(): Promise<void> {
  const pid = listeningPid(RUNTIME_PORT)
  expect(pid, `runtime PID on port ${RUNTIME_PORT}`).not.toBeNull()
  killPidTree(pid as number)
  // No fixed sleep: poll the readiness probe until the port stops answering.
  await expect
    .poll(async () => fetchOk(`http://127.0.0.1:${RUNTIME_PORT}/health`), {
      message: 'runtime /health must stop responding after the kill',
      timeout: 20000,
      intervals: [500, 1000, 2000],
    })
    .toBe(false)
}

async function startRuntime(request: APIRequestContext): Promise<void> {
  expect(existsSync(RUNTIME_EXE), `runtime binary exists at ${RUNTIME_EXE}`).toBe(true)
  const logFile = path.join(HOST_ROOT, 'logs', 'journey-b-runtime-restart.log')
  mkdirSync(path.dirname(logFile), { recursive: true })
  const fd = openSync(logFile, 'a')
  try {
    const child = spawn(RUNTIME_EXE, [], {
      cwd: RUNTIME_DIR,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        XIHE_ENV: 'dev',
        XIHE_CP_API_TOKEN: process.env.XIHE_CP_API_TOKEN ?? '',
        XIHE_AGENT_API_TOKEN: process.env.XIHE_CP_API_TOKEN ?? '',
        XIHE_E2E_RUN_ID: process.env.XIHE_E2E_RUN_ID ?? '',
        XIHE_WORKSPACE_HOST_ROOT: HOST_ROOT,
        XIHE_LOG_DIR: path.join(HOST_ROOT, 'logs'),
        XIHE_LOAD_DOTENV: '0',
        XIHE_REMOTE_MCP_ALLOW_INSECURE_LOCAL: 'true',
        XIHE_RUNTIME_PORT: String(RUNTIME_PORT),
        XIHE_CP_URL: `http://127.0.0.1:${process.env.XIHE_CP_PORT || '12631'}`,
        XIHE_WORKSPACE_IMAGE: 'xihe/workspace:latest',
      } as Record<string, string>,
    })
    child.unref()
  } finally {
    closeSync(fd)
  }
  await waitForHttp(`http://127.0.0.1:${RUNTIME_PORT}/health`)
  await waitForHttp(`http://127.0.0.1:${RUNTIME_PORT}/ready`)
  // CP must observe the runtime again before the UI retries the mutation.
  await expect
    .poll(
      async () => {
        const res = await request.post(`${CP_URL}/api/v1/mcp`, {
          headers: {
            Authorization: `Bearer ${ctx.authToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2026-07-28',
            'X-Workspace-Id': ctx.workspaceId,
          },
          data: {
            jsonrpc: '2.0',
            method: 'tools/call',
            id: 90,
            params: { name: 'read_file', arguments: { path: 'journey-b/seed.md' } },
          },
        })
        return res.status()
      },
      { message: 'CP→Runtime read_file must recover after restart', timeout: 120000, intervals: [2000] },
    )
    .toBe(200)
}

/** Directory nodes render the expand arrow inside the button, so match by suffix. */
function dirButton(page: Page): Locator {
  return page.getByRole('button', { name: /journey-b$/ })
}

/** Wait for the file node; only click the directory when it stayed collapsed. */
async function ensureFileVisible(page: Page, fileName: string): Promise<Locator> {
  const file = page.getByRole('button', { name: fileName, exact: true })
  try {
    await expect(file).toBeVisible({ timeout: 15000 })
  } catch {
    // The refresh may have kept the directory expanded already (the store
    // keeps the parent path); only toggle when the node truly never appeared.
    await dirButton(page).click()
    await expect(file).toBeVisible({ timeout: 15000 })
  }
  return file
}

/** Right-click a directory node, open New File, submit a name and return the modal. */
async function createFileThroughUi(page: Page, dirName: string, fileName: string): Promise<Locator> {
  await page.getByRole('button', { name: new RegExp(`${dirName}$`) }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: /^New File$/ }).click()
  const modal = page.getByTestId('modal-content')
  await expect(modal).toBeVisible({ timeout: 8000 })
  await modal.getByRole('textbox').fill(fileName)
  await modal.getByRole('button', { name: 'Create', exact: true }).click()
  return modal
}

test.describe('@host Journey B — manual workspace mutations (PLAN-0353 D1)', () => {
  test.describe.configure({ mode: 'serial' })
  test.setTimeout(300000)

  test.beforeAll(async ({ request }) => {
    ctx = await registerJourneyUser(request, 'JourneyB')
    // Seed a directory so the file tree offers the directory-level New File menu.
    const seed = await request.post(`${CP_URL}/api/v1/mcp`, {
      headers: {
        Authorization: `Bearer ${ctx.authToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'X-Workspace-Id': ctx.workspaceId,
      },
      data: {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 1,
        params: { name: 'write_file', arguments: { path: 'journey-b/seed.md', content: '# Journey B seed' } },
      },
    })
    expect(seed.status(), `seed write failed: ${seed.status()} ${await seed.text()}`).toBe(200)
  })

  test('B2-audit-user: UI manual mutation lands in the ledger as actorType=user', async ({
    page,
    request,
  }) => {
    seedPage(page, ctx)
    await page.goto('/workspace/' + ctx.workspaceId, { waitUntil: 'load' })
    await expect(dirButton(page)).toBeVisible({ timeout: 30000 })

    const fileName = `journey-b-b2-${Date.now()}.md`
    const modal = await createFileThroughUi(page, 'journey-b', fileName)
    await expect(modal).toBeHidden({ timeout: 20000 })
    await expect(await ensureFileVisible(page, fileName)).toBeVisible({
      timeout: 20000,
    })

    // Ledger fact (API): the newest user mutation is a tool_call with actorType=user.
    let operationId = ''
    await expect
      .poll(
        async () => {
          const res = await request.get(`${CP_URL}/api/v1/operations?size=5`, {
            headers: ctx.headers,
          })
          if (!res.ok()) return 'http'
          const body = (await res.json()) as {
            operations?: Array<{ id: string; actorType?: string; kind?: string }>
          }
          const op = (body.operations ?? []).find(
            (candidate) => candidate.actorType === 'user' && candidate.kind === 'tool_call',
          )
          if (op) {
            operationId = op.id
            return 'ok'
          }
          return 'pending'
        },
        {
          message: 'a user tool_call operation must exist after the UI mutation',
          timeout: 30000,
          intervals: [1000, 2000],
        },
      )
      .toBe('ok')

    const traceRes = await request.get(`${CP_URL}/api/v1/operations/${operationId}`, {
      headers: ctx.headers,
    })
    expect(traceRes.ok(), `trace ${traceRes.status()}`).toBeTruthy()
    const trace = (await traceRes.json()) as {
      items?: Array<{ toolName?: string }>
    }
    const toolNames = (trace.items ?? []).map((item) => item.toolName)
    expect(toolNames, `trace items: ${JSON.stringify(toolNames)}`).toContain('write_file')

    // UI audit view (PLAN-290 B2: visible non-Agent provenance).
    await page.goto('/settings/audit', { waitUntil: 'load' })
    await expect(page.getByTestId('settings-audit-heading')).toBeVisible({ timeout: 20000 })
    const operationRow = page.getByTestId(`settings-audit-operation-${operationId}`)
    await expect(operationRow).toBeVisible({ timeout: 20000 })
    await operationRow.click()
    await expect(page.getByTestId('settings-audit-items')).toContainText('write_file', {
      timeout: 15000,
    })
    await page.screenshot({ path: evidencePath('b2-audit.png'), fullPage: false })
  })

  test('B1-fail-human: Runtime down yields the human-readable sandbox error', async ({ page }) => {
    // Load the tree while Runtime is still up: with Runtime down a cold tree
    // load replaces the panel with its own error state and there is no node to
    // right-click. The B1 assertion targets the mutation path's error copy.
    seedPage(page, ctx)
    await page.goto('/workspace/' + ctx.workspaceId, { waitUntil: 'load' })
    await expect(dirButton(page)).toBeVisible({ timeout: 30000 })

    await killRuntime()

    const fileName = `journey-b-b1-error-${Date.now()}.md`
    const problemResponse = page.waitForResponse(
      (res) =>
        res.url().includes('/api/v1/mcp') &&
        res.status() === 502 &&
        (res.request().postData() ?? '').includes('write_file'),
    )
    await createFileThroughUi(page, 'journey-b', fileName)
    const problem = (await (await problemResponse).json()) as { code?: string }
    expect(problem.code, `problem body: ${JSON.stringify(problem)}`).toBe('RUNTIME_UNAVAILABLE')
    // The failed mutation replaces the tree panel with the humanized error and
    // a Retry affordance (the New File modal unmounts with the tree).
    await expect(page.getByText(HUMAN_RUNTIME_DOWN).first()).toBeVisible({ timeout: 30000 })
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
    await expect(page.getByRole('button', { name: fileName, exact: true })).not.toBeVisible()
    await page.screenshot({ path: evidencePath('b1-error.png'), fullPage: false })
  })

  test('B1-recover: Runtime restart restores manual create/delete with visible tree changes', async ({
    page,
    request,
  }) => {
    await startRuntime(request)

    seedPage(page, ctx)
    await page.goto('/workspace/' + ctx.workspaceId, { waitUntil: 'load' })
    await expect(dirButton(page)).toBeVisible({ timeout: 30000 })

    const fileName = `journey-b-b1-recover-${Date.now()}.md`
    const modal = await createFileThroughUi(page, 'journey-b', fileName)
    await expect(modal).toBeHidden({ timeout: 30000 })
    const created = await ensureFileVisible(page, fileName)
    await expect(created).toBeVisible({ timeout: 30000 })

    // Delete again through the context menu: the tree must reflect both mutations.
    await created.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /^Delete/ }).click()
    const deleteModal = page.getByTestId('modal-content')
    await expect(deleteModal).toBeVisible({ timeout: 8000 })
    await deleteModal.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(created).not.toBeVisible({ timeout: 20000 })
    await page.screenshot({ path: evidencePath('b1-recover.png'), fullPage: false })
  })
})
