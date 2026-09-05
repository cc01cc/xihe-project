import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'

const projectDir = dirname(import.meta.dirname)
const uiDir = join(projectDir, 'packages', 'ui')
const e2eRunId = `host-${Date.now()}-${randomBytes(2).toString('hex')}`
const isKeep = process.argv.includes('--keep')
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
const uiPort = process.env.XIHE_UI_PORT ?? String(portBase)
const cpPort = process.env.XIHE_CP_PORT ?? String(portBase + 1)
const agentPort = process.env.XIHE_AGENT_PORT ?? String(portBase + 2)
const runtimePort = process.env.XIHE_RUNTIME_PORT ?? String(portBase + 3)
const pgPort = process.env.XIHE_PG_PORT ?? String(portBase + 4)
let fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT ?? String(portBase + 10)
let fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT ?? String(portBase + 11)
let fakeLlmPort = process.env.XIHE_FAKE_LLM_PORT ?? String(portBase + 12)
const llmModeArg = process.argv.find((arg) => arg.startsWith('--llm-mode='))
const llmMode = process.env.XIHE_E2E_LLM_MODE ?? llmModeArg?.slice('--llm-mode='.length) ?? 'mock'
const skipRuntime = process.argv.includes('--skip-runtime')
const fakeMcpAccessToken = randomPassword(24)
const e2eAdminPassword = randomPassword(24)

const pgDatabase = `xihe_e2e_${e2eRunId.replace(/[^a-z0-9]/gi, '_')}`
const pgUser = 'xihe'
const pgPassword = randomPassword(18)
const hostRoot = join(projectDir, '.tmp', 'e2e-host', e2eRunId)
const hostRootParent = join(projectDir, '.tmp', 'e2e-host')
const e2eLogDir = join(hostRoot, 'logs')
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

async function reserveFixturePorts() {
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
  await dockerCompose(['up', '-d', '--no-deps', '--wait', '--force-recreate', 'postgres'], {
    env,
    stdio: 'inherit',
  })
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
  if (llmMode !== 'mock') {
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

async function collectIsolatedResources() {
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

    // 4. Host storage is disposable test state; recycle it on Windows.
    try {
      await recycleHostRoot()
    } catch (error) {
      failures.push(`host root cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
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
  try {
    const failures = await collectIsolatedResources()
    teardownResult = { ok: failures.length === 0, failures }
  } catch (error) {
    teardownResult = {
      ok: false,
      failures: [`teardown crashed: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  return teardownResult
}

async function main() {
  console.log(`[e2e-host] runId=${e2eRunId} ports ui=${uiPort} cp=${cpPort} agent=${agentPort} runtime=${runtimePort} pg=${pgPort}`)
  console.log(`[e2e-host] isolated pg project=${pgProjectName} db=${pgDatabase} hostRoot=${hostRoot}`)
  if (skipRuntime) console.log('[e2e-host] --skip-runtime set; this run validates chat-only paths without Sandbox execution')
  await reserveFixturePorts()
  await startFixtures()
  if (externalServer) {
    console.log('[e2e-host] XIHE_E2E_EXTERNAL_SERVER=1 set; assuming services are already running externally')
  } else {
    await startIsolatedPostgres()
    await migrateIsolatedSchema()
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
    await launchNativeService({
      name: 'control-plane',
      cmd: 'mvn.cmd',
      args: ['-q', '-DskipTests', 'spring-boot:run'],
      cwd: join(projectDir, 'packages', 'control-plane'),
      extraEnv: { ...commonCpEnv, XIHE_CP_PORT: cpPort, XIHE_LOG_DIR: e2eLogDir },
      healthUrl: `http://127.0.0.1:${cpPort}/actuator/health`,
    })
    if (llmMode !== 'mock') await configureFakeLlm()
    const nativeServices = [
      launchNativeService({
        name: 'agent',
        cmd: uvCommand,
        args: ['run', 'python', '-m', 'xihe_agent.main'],
        cwd: join(projectDir, 'packages', 'agent'),
        extraEnv: {
          XIHE_AGENT_PORT: agentPort,
          XIHE_CP_URL: `http://127.0.0.1:${cpPort}`,
          XIHE_LLM_PROVIDER: llmMode === 'mock' ? 'mock' : 'openai',
        },
        healthUrl: `http://127.0.0.1:${agentPort}/internal/v1/agent/health`,
      }),
      ...(skipRuntime ? [] : [launchNativeService({
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
      })]),
    ]
    await Promise.all(nativeServices)
    if (!skipRuntime) await waitForHttp('Runtime readiness', `http://127.0.0.1:${runtimePort}/ready`)
    await launchUIVite()
  }
  const result = await runPlaywright()
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
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    process.exitCode = 130
    await cleanup()
    process.exit(130)
  })
}

main().catch(async (error) => {
  console.error(`[e2e-host] ${error instanceof Error ? error.message : String(error)}`)
  await cleanup()
  process.exitCode = 1
})
