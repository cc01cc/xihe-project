import { join, dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'

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

const portBase = 27000 + (Math.abs(hashString(e2eRunId)) % 1500)
const uiPort = process.env.XIHE_UI_PORT ?? String(portBase)
const cpPort = process.env.XIHE_CP_PORT ?? String(portBase + 1)
const agentPort = process.env.XIHE_AGENT_PORT ?? String(portBase + 2)
const runtimePort = process.env.XIHE_RUNTIME_PORT ?? String(portBase + 3)
const pgPort = process.env.XIHE_PG_PORT ?? String(portBase + 4)
const fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT ?? String(portBase + 10)
const fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT ?? String(portBase + 11)
const fakeMcpAccessToken = randomPassword(24)

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

async function waitForHttp(name, url, timeoutMs = readinessTimeoutMs, headers = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'not ready'
  while (Date.now() < deadline) {
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
  await waitForHttp(name, healthUrl)
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
  await waitForHttp('UI', `http://127.0.0.1:${uiPort}`)
}

async function startFixtures() {
  const fixtures = [
    { name: 'Fake OAuth', script: 'fake-oauth-server.mjs', port: fakeOAuthPort, env: { XIHE_FAKE_OAUTH_PORT: fakeOAuthPort } },
    { name: 'Fake MCP', script: 'fake-mcp-server.mjs', port: fakeMcpPort, env: {
      XIHE_FAKE_MCP_PORT: fakeMcpPort,
      XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
    } },
  ]
  for (const { name, script, port, env } of fixtures) {
    const child = spawnCommand(nodeCommand, [join(uiDir, 'e2e', 'fixtures', script)], {
      cwd: projectDir,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      windowsHide: true,
    })
    dockerProcesses.push({ name, child })
    child.once('error', (error) => console.error(`[e2e-host] ${name} process error: ${error.message}`))
    await waitForHttp(name, `http://localhost:${port}/health`)
  }
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
  const testArgs = process.argv.slice(2).filter((arg) => !['--keep'].includes(arg))
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
      XIHE_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
    }
    await Promise.all([
      launchNativeService({
        name: 'control-plane',
        cmd: 'mvn.cmd',
        args: ['-q', '-DskipTests', 'spring-boot:run'],
        cwd: join(projectDir, 'packages', 'control-plane'),
        extraEnv: { ...commonCpEnv, XIHE_CP_PORT: cpPort, XIHE_LOG_DIR: e2eLogDir },
        healthUrl: `http://127.0.0.1:${cpPort}/actuator/health`,
      }),
      launchNativeService({
        name: 'agent',
        cmd: uvCommand,
        args: ['run', 'python', '-m', 'xihe_agent.main'],
        cwd: join(projectDir, 'packages', 'agent'),
        extraEnv: {
          XIHE_AGENT_PORT: agentPort,
          XIHE_CP_URL: `http://127.0.0.1:${cpPort}`,
          XIHE_LLM_PROVIDER: 'mock',
        },
        healthUrl: `http://127.0.0.1:${agentPort}/internal/v1/agent/health`,
      }),
      launchNativeService({
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
      }),
    ])
    await waitForHttp('Runtime readiness', `http://127.0.0.1:${runtimePort}/ready`)
     await launchUIVite()
  }
  await startFixtures()
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
