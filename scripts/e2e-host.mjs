import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { stat as stat2, readdir, writeFile, readFile } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'

const projectDir = dirname(import.meta.dirname)
const uiDir = join(projectDir, 'packages', 'ui')
const e2eRunId = `host-${Date.now()}-${randomBytes(2).toString('hex')}`
const isKeep = process.argv.includes('--keep')
// PLAN-294 M4-a: persistent stack for regression matrices — boot the whole
// isolated stack once, then run Playwright repeatedly against it.
const isPersistent = process.argv.includes('--persistent')
const isTeardown = process.argv.includes('--teardown')
const stateFile = join(projectDir, '.tmp', 'e2e-host', 'persistent-stack.json')
const externalServer = process.env.XIHE_E2E_EXTERNAL_SERVER === '1'

const workerCount = process.env.XIHE_E2E_WORKERS ?? '1'
const readinessTimeoutMs = Number(process.env.XIHE_E2E_READY_TIMEOUT_MS ?? '180000')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const uvCommand = process.platform === 'win32' ? 'uv.exe' : 'uv'
const nodeCommand = process.execPath

const portBaseRaw = 27000 + (Math.abs(hashString(e2eRunId)) % 1500)
// 27339 is excluded at OS level (HTTP.sys AURASDK reservation, see
// `netsh int ipv4 show excludedportrange`). Service ports below are used
// without probing, so shift the block when it would overlap the dead port.
const portBase = portBaseRaw <= 27339 && 27339 < portBaseRaw + 13 ? portBaseRaw + 20 : portBaseRaw
let uiPort = process.env.XIHE_UI_PORT ?? String(portBase)
let cpPort = process.env.XIHE_CP_PORT ?? String(portBase + 1)
let agentPort = process.env.XIHE_AGENT_PORT ?? String(portBase + 2)
let runtimePort = process.env.XIHE_RUNTIME_PORT ?? String(portBase + 3)
let pgPort = process.env.XIHE_PG_PORT ?? String(portBase + 4)
let fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT ?? String(portBase + 10)
let fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT ?? String(portBase + 11)
let fakeLlmPort = process.env.XIHE_FAKE_LLM_PORT ?? String(portBase + 12)
const llmModeArg = process.argv.find((arg) => arg.startsWith('--llm-mode='))
const llmMode = process.env.XIHE_E2E_LLM_MODE ?? llmModeArg?.slice('--llm-mode='.length) ?? 'mock'
const skipRuntime = process.argv.includes('--skip-runtime')
// Supplementary real-provider sampling (PLAN-247, requires explicit user
// approval per run). The key travels only via this env var into the CP Admin
// API import below; it is never logged, never written to fixtures, and never
// committed. When set, the Fake LLM fixture is skipped and llmMode is used
// only for spec selection.
const realXiaomiKey = process.env.XIHE_E2E_REAL_XIAOMI_KEY ?? ''
const fakeMcpAccessToken = randomPassword(24)
const e2eAdminPassword = randomPassword(24)

const pgDatabase = `xihe_e2e_${e2eRunId.replace(/[^a-z0-9]/gi, '_')}`
const pgUser = 'xihe'
const pgPassword = randomPassword(18)
const hostRoot = join(projectDir, '.tmp', 'e2e-host', e2eRunId)
const hostRootParent = join(projectDir, '.tmp', 'e2e-host')
const e2eLogDir = join(hostRoot, 'logs')

// ③1 (PLAN-294 review): prune run dirs older than 3 days so failed-run
// preservation (G-1) cannot grow .tmp/e2e-host unbounded.
async function pruneStaleRunDirs() {
  if (!existsSync(hostRootParent)) return
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000
  for (const entry of await readdir(hostRootParent)) {
    const dir = join(hostRootParent, entry)
    try {
      const stat = await stat2(dir)
      if (!stat.isDirectory()) continue
      if (stat.mtimeMs > cutoff) continue
      // Recycle (recoverable) instead of rm on Windows.
      if (process.platform === 'win32') {
        await run('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-Command',
          "$path = $env:XIHE_E2E_HOST_ROOT; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin')",
        ], { env: { XIHE_E2E_HOST_ROOT: dir }, stdio: 'ignore' })
      } else {
        await rm(dir, { recursive: true, force: true })
      }
      console.log(`[e2e-host] pruned stale run dir ${entry}`)
    } catch (error) {
      console.warn(`[e2e-host] prune ${entry} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
const pgProjectName = `xihe-e2e-host-${e2eRunId.replace(/[^a-z0-9]/gi, '')}`
const serviceToken = randomPassword(24)
const nativeNoProxy = [
  process.env.NO_PROXY,
  process.env.no_proxy,
  'localhost',
  '127.0.0.1',
  'host.docker.internal',
].filter(Boolean).join(',')

const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker'

const dockerProcesses = []
let cleaned = false
let teardownResult = { ok: true, failures: [] }
let result = { code: 0 }

function hashString(input) {
  let h = 0
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) | 0
  }
  return h
}

function randomPassword(length) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(length)
  let result = ''
  for (let i = 0; i < length; i += 1) {
    result += charset[bytes[i] % charset.length]
  }
  return result
}

function reservePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer()
    const listen = (port) => probe.listen(port, '127.0.0.1')
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE' && preferredPort !== '0') {
        listen(0)
        return
      }
      reject(error)
    })
    probe.once('listening', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(String(port)))
    })
    listen(Number(preferredPort))
  })
}

async function reserveHostPorts() {
  if (!process.env.XIHE_UI_PORT) uiPort = await reservePort(uiPort)
  if (!process.env.XIHE_CP_PORT) cpPort = await reservePort(cpPort)
  if (!process.env.XIHE_AGENT_PORT) agentPort = await reservePort(agentPort)
  if (!process.env.XIHE_RUNTIME_PORT) runtimePort = await reservePort(runtimePort)
  if (!process.env.XIHE_PG_PORT) pgPort = await reservePort(pgPort)
  if (!process.env.XIHE_FAKE_OAUTH_PORT) fakeOAuthPort = await reservePort(fakeOAuthPort)
  if (!process.env.XIHE_FAKE_MCP_PORT) fakeMcpPort = await reservePort(fakeMcpPort)
  if (!process.env.XIHE_FAKE_LLM_PORT) fakeLlmPort = await reservePort(fakeLlmPort)
}

function isWithin(child, parent) {
  const childPath = child.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  const parentPath = parent.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`)
}

function spawnCommand(program, args, options) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(program)) {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', program, ...args], options)
  }
  return spawn(program, args, options)
}

function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(program, args, {
      cwd: options.cwd ?? projectDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, child }))
  })
}

function runCapture(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(program, args, {
      cwd: options.cwd ?? projectDir,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({
      code: code ?? 1,
      signal,
      stdout,
      stderr,
      child,
    }))
  })
}

async function waitForHttp(name, url, timeoutMs = readinessTimeoutMs, headers = {}, child = null) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'not ready'
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`${name} exited before becoming ready (code=${child.exitCode})`)
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try {
      const response = await fetch(url, {
        headers: { 'X-Request-Id': `e2e-${e2eRunId}`, ...headers },
        signal: controller.signal,
      })
      if (response.ok) {
        console.log(`[e2e-host] ${name} ready: ${url}`)
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`${name} did not become ready within ${timeoutMs}ms (${lastError})`)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    try {
      await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // best-effort cleanup
    }
  } else {
    child.kill('SIGTERM')
  }
}

async function dockerCompose(args, options = {}) {
  return run(
    dockerCommand,
    ['compose', '-p', pgProjectName, '-f', join(projectDir, 'docker-compose.yml'), ...args],
    options,
  )
}

async function startIsolatedPostgres() {
  const env = {
    XIHE_PG_PORT: pgPort,
    POSTGRES_DB: pgDatabase,
    POSTGRES_USER: pgUser,
    POSTGRES_PASSWORD: pgPassword,
  }
  const result = await dockerCompose(['up', '-d', '--no-deps', '--wait', '--force-recreate', 'postgres'], {
    env,
    stdio: 'inherit',
  })
  if (result.code !== 0) {
    throw new Error(`isolated PostgreSQL failed to start (exit=${result.code})`)
  }
}

async function migrateIsolatedSchema() {
  // The CP migration runs on boot. We just wait for it via the actuator health probe.
}

async function launchNativeService({ name, cmd, args, cwd, extraEnv, healthUrl }) {
  console.log(`[e2e-host] launching native ${name}`)
  const child = spawnCommand(cmd, args, {
    cwd: cwd ?? join(projectDir, 'packages', name),
    env: {
      ...process.env,
      XIHE_ENV: 'dev',
       XIHE_CP_API_TOKEN: serviceToken,
       XIHE_AGENT_API_TOKEN: serviceToken,
      XIHE_E2E_RUN_ID: e2eRunId,
      XIHE_WORKSPACE_HOST_ROOT: hostRoot,
      XIHE_LOG_DIR: e2eLogDir,
      XIHE_LOAD_DOTENV: '0',
      XIHE_REMOTE_MCP_ALLOW_INSECURE_LOCAL: 'true',
      NO_PROXY: nativeNoProxy,
      no_proxy: nativeNoProxy,
      ...extraEnv,
    },
    stdio: 'inherit',
    windowsHide: true,
  })
  dockerProcesses.push({ name, child })
  child.once('exit', (code, signal) => {
    console.log(`[e2e-host] native ${name} exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
  })
  child.once('error', (error) => {
    console.error(`[e2e-host] native ${name} error: ${error.message}`)
  })
  await waitForHttp(name, healthUrl, readinessTimeoutMs, {}, child)
}

async function launchUIVite() {
  console.log('[e2e-host] launching UI Vite')
  const child = spawnCommand(nodeCommand, [join(projectDir, 'scripts', 'dev-ui-host.mjs'), '--mode', 'dev', '--host', '127.0.0.1', '--port', uiPort, '--strictPort'], {
    cwd: uiDir,
    env: {
      ...process.env,
      XIHE_ENV: 'dev',
       XIHE_UI_PORT: uiPort,
       XIHE_CP_BASE_URL: `http://127.0.0.1:${cpPort}`,
       XIHE_LOG_DIR: e2eLogDir,
    },
    stdio: 'inherit',
    windowsHide: true,
  })
  dockerProcesses.push({ name: 'ui', child })
  child.once('exit', (code, signal) => {
    console.log(`[e2e-host] ui exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
  })
  child.once('error', (error) => {
    console.error(`[e2e-host] ui error: ${error.message}`)
  })
  await waitForHttp('UI', `http://127.0.0.1:${uiPort}`, readinessTimeoutMs, {}, child)
}

async function startFixtures() {
  const fixtures = [
    { name: 'Fake OAuth', script: 'fake-oauth-server.mjs', port: fakeOAuthPort, env: {
      XIHE_FAKE_OAUTH_PORT: fakeOAuthPort,
      XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
    } },
    { name: 'Fake MCP', script: 'fake-mcp-server.mjs', port: fakeMcpPort, env: {
      XIHE_FAKE_MCP_PORT: fakeMcpPort,
      XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
    } },
  ]
  if (llmMode !== 'mock' && !realXiaomiKey) {
    fixtures.push({ name: 'Fake LLM', script: 'fake-llm-server.mjs', port: fakeLlmPort, env: {
      XIHE_FAKE_LLM_PORT: fakeLlmPort,
      XIHE_FAKE_LLM_MODE: llmMode,
    } })
  }
  for (const { name, script, port, env } of fixtures) {
    const child = spawnCommand(nodeCommand, [join(uiDir, 'e2e', 'fixtures', script)], {
      cwd: projectDir,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      windowsHide: true,
    })
    dockerProcesses.push({ name, child })
    child.once('error', (error) => console.error(`[e2e-host] ${name} process error: ${error.message}`))
    await waitForHttp(name, `http://localhost:${port}/health`, readinessTimeoutMs, {}, child)
  }
}

async function configureFakeLlm() {
  const cpBaseUrl = `http://127.0.0.1:${cpPort}`
  const login = await fetch(`${cpBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@xihe.local', password: e2eAdminPassword }),
  })
  if (!login.ok) throw new Error(`fake LLM admin login failed: HTTP ${login.status}`)
  const loginBody = await login.json()
  if (realXiaomiKey) {
    const imported = await fetch(`${cpBaseUrl}/api/v1/config/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${loginBody.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        'llm-provider': {
          defaultProvider: 'xiaomi',
          xiaomiApiKey: realXiaomiKey,
          xiaomiModel: 'mimo-v2.5',
        },
        'user-preference': {
          defaultModel: 'mimo-v2.5',
        },
      }),
    })
    if (!imported.ok) {
      const problem = await imported.text()
      throw new Error(`real provider config import failed: HTTP ${imported.status} ${problem.slice(0, 500)}`)
    }
    console.log('[e2e-host] real Xiaomi configuration imported (key redacted from all evidence)')
    return
  }
  const fakeBase = `http://127.0.0.1:${fakeLlmPort}`
  const config = llmMode === 'missing'
    ? {
        'llm-provider': {
          defaultProvider: '',
          openaiApiKey: '',
          openaiApiBase: `${fakeBase}/openai/v1`,
        },
        'user-preference': {
          defaultModel: 'gpt-fake',
        },
      }
    : {
        'llm-provider': {
          defaultProvider: 'openai',
          openaiApiKey: llmMode === 'invalid' ? 'sk-fake-invalid-key' : 'sk-fake-openai-key',
          openaiModel: 'fake-openai',
          openaiApiBase: `${fakeBase}/openai/v1`,
          deepseekApiKey: 'fake-deepseek-key',
          deepseekModel: 'fake-deepseek',
          deepseekApiBase: `${fakeBase}/deepseek/v1`,
        },
        'user-preference': {
          defaultModel: 'fake-openai',
        },
      }
  const imported = await fetch(`${cpBaseUrl}/api/v1/config/import`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${loginBody.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  })
  if (!imported.ok) {
    const problem = await imported.text()
    throw new Error(`fake LLM config import failed: HTTP ${imported.status} ${problem.slice(0, 500)}`)
  }
  console.log(`[e2e-host] fake LLM configuration imported mode=${llmMode}`)
}

async function removeRunSandboxContainers() {
  const listed = await runCapture(dockerCommand, [
    'ps', '-aq', '--filter', `label=xihe.e2e.run-id=${e2eRunId}`,
  ])
  if (listed.code !== 0) {
    throw new Error(`list e2e Sandbox containers failed: ${listed.stderr.trim()}`)
  }
  const ids = listed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean)
  for (const id of ids) {
    const removed = await run(dockerCommand, ['rm', '-f', id], { stdio: 'inherit' })
    if (removed.code !== 0) {
      throw new Error(`remove e2e Sandbox container ${id} failed with exit=${removed.code}`)
    }
  }
  return ids.length
}

async function recycleHostRoot() {
  if (!existsSync(hostRoot)) return
  if (!isWithin(hostRoot, hostRootParent) || hostRoot.toLowerCase() === hostRootParent.toLowerCase()) {
    throw new Error(`refusing to recycle unsafe host root: ${hostRoot}`)
  }
  if (process.platform === 'win32') {
    const result = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$path = $env:XIHE_E2E_HOST_ROOT; Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin')",
    ], {
      env: { XIHE_E2E_HOST_ROOT: hostRoot },
      stdio: 'ignore',
    })
    if (result.code !== 0) {
      throw new Error(`recycle e2e host root failed with exit=${result.code}`)
    }
    return
  }
  await rm(hostRoot, { recursive: true, force: true })
}

async function runPlaywright() {
  const testArgs = process.argv.slice(2).filter((arg) => !['--keep', '--skip-runtime'].includes(arg) && !arg.startsWith('--llm-mode='))
  const playwrightTestArgs = testArgs.length > 0 ? testArgs : ['e2e/real']
  return run(pnpmCommand, [
    'exec',
    'playwright',
    'test',
    '--config',
    'e2e/playwright.config.ts',
    ...playwrightTestArgs,
    '--grep',
    '@host',
    '--workers',
    workerCount,
  ], {
    cwd: uiDir,
    env: {
      XIHE_E2E_PROFILE: 'host',
      XIHE_E2E_EXTERNAL_SERVER: '1',
      XIHE_E2E_RUN_ID: e2eRunId,
      XIHE_CP_API_TOKEN: serviceToken,
      XIHE_UI_PORT: uiPort,
      XIHE_CP_PORT: cpPort,
      XIHE_AGENT_PORT: agentPort,
      XIHE_RUNTIME_PORT: runtimePort,
      XIHE_FAKE_OAUTH_PORT: fakeOAuthPort,
      XIHE_FAKE_MCP_PORT: fakeMcpPort,
      XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
      XIHE_E2E_LLM_MODE: llmMode,
      XIHE_E2E_HEADED: process.env.XIHE_E2E_HEADED ?? '0',
      XIHE_E2E_BROWSER_CHANNEL: process.env.XIHE_E2E_BROWSER_CHANNEL ?? 'chrome-beta',
    },
  })
}

async function collectIsolatedResources(preserveRunDir = false) {
  const failures = []

  if (isKeep) {
    console.log(`[e2e-host] --keep set; preserving isolated resources for ${e2eRunId}`)
    return failures
  }

  // 1. Stop native processes before tearing down their isolated database.
  for (const entry of dockerProcesses.slice().reverse()) {
    try {
      await stopProcess(entry.child)
    } catch (error) {
      failures.push(`stop ${entry.name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (!externalServer) {
    // 2. Remove only Sandbox containers labeled for this run.
    try {
      const removed = await removeRunSandboxContainers()
      console.log(`[e2e-host] removed ${removed} Sandbox containers for ${e2eRunId}`)
    } catch (error) {
      failures.push(`Sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 3. Destroy the isolated PostgreSQL project and volume.
    try {
      const down = await dockerCompose(['down', '--volumes', '--remove-orphans'], { stdio: 'inherit' })
      if (down.code !== 0) failures.push(`compose down exit=${down.code}`)
    } catch (error) {
      failures.push(`compose down failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    // ①3 (PLAN-294 review): on failure dump the context/ledger rows a
    // debugger needs (compaction cursor, usage extensions) next to the logs
    // — reading them used to require a whole extra run with --keep.
    if (preserveRunDir) {
      console.log(`[e2e-host] host root preserved for failed run ${e2eRunId}`)
      try {
        const dump = await run('docker', [
          'exec', `${pgProjectName}-postgres-1`,
          'pg_dump', '-U', pgUser, '-d', pgDatabase,
          '--table=context_events', '--table=operation_extensions', '--table=chat_runs',
          '--data-only',
        ], { stdio: ['ignore', 'pipe', 'ignore'] })
        if (dump.code === 0 && dump.stdout) {
          const snapshotPath = join(e2eLogDir, 'db-state-dump.sql')
          await writeFile(snapshotPath, dump.stdout)
          console.log(`[e2e-host] DB state dump written: ${snapshotPath}`)
        } else {
          console.warn('[e2e-host] DB state dump unavailable (container already down?)')
        }
      } catch (error) {
        console.warn(`[e2e-host] DB state dump failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      try {
        await recycleHostRoot()
      } catch (error) {
        failures.push(`host root cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const probeUrls = [
      `http://127.0.0.1:${pgPort}/`,
      `http://127.0.0.1:${cpPort}/actuator/health`,
      `http://127.0.0.1:${agentPort}/internal/v1/agent/health`,
      `http://127.0.0.1:${runtimePort}/health`,
      `http://127.0.0.1:${uiPort}/`,
    ]
    const probe = await Promise.all(probeUrls.map(async (url) => {
      try {
        const response = await fetch(url)
        return { url, responded: true, status: response.status }
      } catch {
        return { url, responded: false, status: null }
      }
    }))
    for (const result of probe) {
      if (result.responded) failures.push(`service still responding after teardown: ${result.url} HTTP ${result.status}`)
    }

    const remainingContainers = await runCapture(dockerCommand, [
      'ps', '-aq', '--filter', `label=xihe.e2e.run-id=${e2eRunId}`,
    ])
    if (remainingContainers.code !== 0) {
      failures.push(`Sandbox reverse assertion failed: ${remainingContainers.stderr.trim()}`)
    } else if (remainingContainers.stdout.trim()) {
      failures.push(`Sandbox containers remain after teardown: ${remainingContainers.stdout.trim()}`)
    }
    if (existsSync(hostRoot)) failures.push(`host root remains after teardown: ${hostRoot}`)
  } else {
    console.log(`[e2e-host] external server mode; isolated DB/host root teardown skipped for ${e2eRunId}`)
  }
  return failures
}

async function cleanup() {
  if (cleaned) return teardownResult
  cleaned = true
  // PLAN-294 appendix G-1: a failed run without --keep used to delete its
  // own logs with teardown, forcing a full rerun just to read an exception.
  // Preserve the run directory when the tests failed (recycled later by
  // normal .tmp hygiene); --keep still preserves everything unconditionally.
  const preserveRunDir = result && result.code !== 0
  if (preserveRunDir && existsSync(e2eLogDir)) {
    console.log(`[e2e-host] tests failed; preserving logs at ${e2eLogDir} (recycle with .tmp cleanup)`)
  }
  try {
    const failures = await collectIsolatedResources(preserveRunDir)
    teardownResult = { ok: failures.length === 0, failures }
  } catch (error) {
    teardownResult = {
      ok: false,
      failures: [`teardown crashed: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  return teardownResult
}

// ③3 (PLAN-294 review): a running dev runtime holds xihe-runtime.exe, so
// `cargo run --bin xihe-runtime` fails with os error 5. Detect and say so —
// this cost a debugging round trip in PLAN-294 M0.
async function waitPostgresReady() {
  const deadline = Date.now() + readinessTimeoutMs
  while (Date.now() < deadline) {
    const result = await run('docker', [
      'exec', `${pgProjectName}-postgres-1`,
      'pg_isready', '-U', pgUser, '-d', pgDatabase,
    ], { stdio: 'ignore' })
    if (result.code === 0) {
      console.log('[e2e-host] PostgreSQL (for CP) ready (pg_isready)')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error('PostgreSQL did not become ready in time (pg_isready)')
}

async function precheckDevRuntimeConflict() {
  if (skipRuntime || process.platform !== 'win32') return
  const result = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "(Get-NetTCPConnection -LocalPort 12633 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess",
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  const pid = (result.stdout || '').trim()
  if (!pid) return
  const nameProbe = await run('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid}).Path`,
  ], { stdio: ['ignore', 'pipe', 'ignore'] })
  const exePath = (nameProbe.stdout || '').trim()
  console.error(`[e2e-host] port 12633 is held by PID ${pid} (${exePath || 'unknown process'}).`)
  console.error('[e2e-host] A dev runtime blocks `cargo run --bin xihe-runtime` (binary lock, os error 5).')
  console.error('[e2e-host] Stop it first:  taskkill /PID <pid> /F   (or `mise run dev:host:stop` for the whole stack),')
  console.error('[e2e-host] or skip the runtime here with --skip-runtime.')
  throw new Error('dev runtime conflict on port 12633')
}

async function teardownPersistent() {
  // Read the state file written by --persistent and stop that stack.
  if (!existsSync(stateFile)) {
    console.error('[e2e-host] no persistent stack state file found; nothing to tear down')
    return
  }
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  console.log(`[e2e-host] tearing down persistent stack ${state.runId}`)
  await stopPersistentProcesses(state)
  if (process.platform === 'win32') {
    await run('docker', ['compose', '-p', state.pgProjectName, '-f', join(projectDir, 'docker-compose.yml'), 'down', '--volumes', '--remove-orphans'], { stdio: 'inherit' })
  }
  await rm(stateFile, { force: true })
  console.log('[e2e-host] persistent stack torn down')
}

async function stopPersistentProcesses(state) {
  for (const name of Object.keys(state.pids || {})) {
    const pid = state.pids[name]
    if (!pid) continue
    if (process.platform === 'win32') {
      await run('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      await run('kill', ['-TERM', String(pid)], { stdio: 'ignore' })
    }
    console.log(`[e2e-host] stopped persistent ${name} (pid=${pid})`)
  }
}

async function main() {
  if (isTeardown) {
    await teardownPersistent()
    return
  }
  console.log(`[e2e-host] runId=${e2eRunId} ports ui=${uiPort} cp=${cpPort} agent=${agentPort} runtime=${runtimePort} pg=${pgPort}`)
  console.log(`[e2e-host] isolated pg project=${pgProjectName} db=${pgDatabase} hostRoot=${hostRoot}`)
  if (skipRuntime) console.log('[e2e-host] --skip-runtime set; this run validates chat-only paths without Sandbox execution')
  await precheckDevRuntimeConflict()
  await pruneStaleRunDirs()

  // Reuse mode: a persistent stack is already up — point this run's ports at
  // it and skip every boot phase.
  if (externalServer && existsSync(stateFile)) {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    uiPort = state.ports.ui; cpPort = state.ports.cp; agentPort = state.ports.agent
    runtimePort = state.ports.runtime; pgPort = state.ports.pg
    console.log(`[e2e-host] persistent stack ${state.runId}: ui=${uiPort} cp=${cpPort} agent=${agentPort} runtime=${runtimePort}`)
  } else if (externalServer) {
    console.log('[e2e-host] XIHE_E2E_EXTERNAL_SERVER=1 set; assuming services are already running externally')
  }

  if (externalServer) {
    // reuse path: the persistent stack is already up, skip all boot phases
  } else {
  // PLAN-294 F.5 L1+L2: parallel boot orchestration. Fixtures and PostgreSQL
  // run concurrently; then all four services launch together (Agent's config
  // sync self-heals via periodic re-poll when CP is not ready yet; the chat
  // path's LLM readiness gate covers the remaining window). CP prefers the
  // pre-built fat jar (skips ~20s of Maven lifecycle per boot).
    const cpDatasource = `jdbc:postgresql://localhost:${pgPort}/${pgDatabase}`
    const commonCpEnv = {
      XIHE_CP_PORT: cpPort,
      XIHE_CP_DATASOURCE_URL: cpDatasource,
      XIHE_CP_DATASOURCE_USERNAME: pgUser,
      XIHE_CP_DATASOURCE_PASSWORD: pgPassword,
      XIHE_CP_JWT_SECRET: `e2e-${e2eRunId}-jwt-secret`,
       XIHE_AGENT_URL: `http://127.0.0.1:${agentPort}/internal/v1/agent/chat`,
       XIHE_AGENT_BASE_URL: `http://127.0.0.1:${agentPort}`,
       XIHE_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
       XIHE_DEV_ADMIN_PASSWORD: e2eAdminPassword,
     }
    const cpJar = join(projectDir, 'packages', 'control-plane', 'target', 'control-plane-0.1.0.jar')
    const useCpJar = existsSync(cpJar)
    if (useCpJar) console.log('[e2e-host] CP boot via pre-built fat jar (java -jar); mvn package to refresh it')

    const bootTasks = [
      // PostgreSQL first (CP datasource needs it), but everything else in
      // parallel with it.
      (async () => {
        await startIsolatedPostgres()
        await migrateIsolatedSchema()
      })(),
      (async () => {
        await startFixtures()
      })(),
      (async () => {
        // CP waits for its datasource: gate the process start on PostgreSQL
        // readiness via pg_isready (PG speaks the wire protocol, not HTTP —
        // an HTTP probe here never succeeds).
        await waitPostgresReady()
        if (!useCpJar) {
          await launchNativeService({
            name: 'control-plane',
            cmd: 'mvn.cmd',
            args: ['-q', '-DskipTests', 'spring-boot:run'],
            cwd: join(projectDir, 'packages', 'control-plane'),
            extraEnv: { ...commonCpEnv, XIHE_CP_PORT: cpPort, XIHE_LOG_DIR: e2eLogDir },
            healthUrl: `http://127.0.0.1:${cpPort}/actuator/health`,
          })
          if (llmMode !== 'mock') await configureFakeLlm()
        } else {
          const child = spawnCommand('java', ['-jar', cpJar], {
            cwd: join(projectDir, 'packages', 'control-plane'),
            env: {
              ...process.env,
              XIHE_CP_API_TOKEN: serviceToken,
              XIHE_AGENT_API_TOKEN: serviceToken,
              XIHE_E2E_RUN_ID: e2eRunId,
              XIHE_WORKSPACE_HOST_ROOT: hostRoot,
              XIHE_REMOTE_MCP_ALLOW_INSECURE_LOCAL: 'true',
              ...commonCpEnv,
              XIHE_CP_PORT: cpPort,
              XIHE_LOG_DIR: e2eLogDir,
              XIHE_LOAD_DOTENV: '0',
            },
            stdio: 'inherit',
            windowsHide: true,
          })
          dockerProcesses.push({ name: 'control-plane', child })
          child.once('exit', (code, signal) => {
            console.log(`[e2e-host] native control-plane exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
          })
          // PG readiness was already gated by waitPostgresReady in the CP
          // task prologue; just wait for Spring to finish booting.
          await waitForHttp('control-plane', `http://127.0.0.1:${cpPort}/actuator/health`, readinessTimeoutMs, {}, child)
          if (llmMode !== 'mock') await configureFakeLlm()
        }
      })(),
      (async () => {
        // Agent waits for the fake fixtures only when it needs their LLM
        // endpoints; config sync self-heals otherwise.
        await launchNativeService({
          name: 'agent',
          cmd: uvCommand,
          args: ['run', 'python', '-m', 'xihe_agent.main'],
          cwd: join(projectDir, 'packages', 'agent'),
          extraEnv: {
            XIHE_AGENT_PORT: agentPort,
            XIHE_CP_URL: `http://127.0.0.1:${cpPort}`,
            XIHE_LLM_PROVIDER: realXiaomiKey ? 'xiaomi' : llmMode === 'mock' ? 'mock' : 'openai',
          },
          healthUrl: `http://127.0.0.1:${agentPort}/internal/v1/agent/health`,
        })
        // F.5: under parallel boot the Agent starts before CP/fake-config is
        // ready; its config sync then 401s and the next re-poll is 30s away.
        // Playwright must not start until the agent actually reports
        // llmReady=ready, or the first chat 503s out of the send window.
        const agentDeadline = Date.now() + readinessTimeoutMs
        while (Date.now() < agentDeadline) {
          try {
            const res = await fetch(`http://127.0.0.1:${agentPort}/internal/v1/agent/health`)
            if (res.ok) {
              const body = await res.json()
              if (body.llmReady === 'ready') break
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 2_000))
        }
      })(),
      ...(skipRuntime ? [] : [(async () => {
        await launchNativeService({
          name: 'runtime',
          cmd: 'cargo',
          args: ['run', '--bin', 'xihe-runtime'],
          cwd: join(projectDir, 'packages', 'runtime'),
          extraEnv: {
            XIHE_RUNTIME_PORT: runtimePort,
            XIHE_CP_URL: `http://127.0.0.1:${cpPort}`,
            XIHE_WORKSPACE_IMAGE: 'xihe/workspace:latest',
          },
          healthUrl: `http://127.0.0.1:${runtimePort}/health`,
        })
        if (!skipRuntime) await waitForHttp('Runtime readiness', `http://127.0.0.1:${runtimePort}/ready`)
      })()]),
      launchUIVite(),
    ]
    await Promise.all(bootTasks)
  }
  if (isPersistent) {
    // Boot-only mode: record the stack and exit 0 without running tests or
    // tearing anything down. Subsequent runs reuse it (externalServer path),
    // and `--teardown` stops it.
    const pids = {}
    for (const entry of dockerProcesses) pids[entry.name] = entry.child.pid ?? null
    await writeFile(stateFile, JSON.stringify({
      runId: e2eRunId,
      ports: { ui: uiPort, cp: cpPort, agent: agentPort, runtime: runtimePort, pg: pgPort },
      pgProjectName,
      pids,
    }, null, 2))
    console.log(`[e2e-host] persistent stack ready; state written to ${stateFile}`)
    console.log('[e2e-host] run specs with: XIHE_E2E_EXTERNAL_SERVER=1 node scripts/e2e-host.mjs --llm-mode=<mode> <specs...>')
    console.log('[e2e-host] stop it with: node scripts/e2e-host.mjs --teardown')
    process.exitCode = 0
    return
  }
  result = await runPlaywright()
  const teardown = await cleanup()
  if (!teardown.ok) {
    console.error('[e2e-host] teardown reported residual resources:')
    for (const failure of teardown.failures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 2
    return
  }
  process.exitCode = result.code
  // ③2 (PLAN-294 review): Host E2E requires the dev runtime stopped (binary
  // lock); remind the operator instead of leaving the stack headless.
  if (process.platform === 'win32') {
    const probe = await run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'if (Get-NetTCPConnection -LocalPort 12633 -State Listen -ErrorAction SilentlyContinue) { echo down } else { echo down }',
    ], { stdio: ['ignore', 'pipe', 'ignore'] })
    void probe
    console.log('[e2e-host] reminder: dev runtime was stopped for this run — restart with `mise run dev:runtime` (or dev:host) if you need the dev stack.')
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    process.exitCode = 130
    // Persistent mode hands stack ownership to --teardown; an interrupt
    // (Ctrl+C or a supervisor kill) must not tear the stack down.
    if (isPersistent) {
      console.log('[e2e-host] persistent stack left running; tear down with: node scripts/e2e-host.mjs --teardown')
      process.exit(130)
    }
    await cleanup()
    process.exit(130)
  })
}

main().catch(async (error) => {
  console.error(`[e2e-host] ${error instanceof Error ? error.message : String(error)}`)
  await cleanup()
  process.exitCode = 1
})
