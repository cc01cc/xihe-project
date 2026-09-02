import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const projectDir = dirname(import.meta.dirname)
const uiDir = join(projectDir, 'packages', 'ui')
const composeFile = join(projectDir, 'docker-compose.yml')
const portSeed = 20000 + ((process.pid * 7) % 10000)
const uiPort = process.env.XIHE_UI_PORT ?? String(portSeed)
const cpPort = process.env.XIHE_CP_PORT ?? String(portSeed + 1)
const agentPort = process.env.XIHE_AGENT_PORT ?? String(portSeed + 2)
const runtimePort = process.env.XIHE_RUNTIME_PORT ?? String(portSeed + 3)
const pgPort = process.env.XIHE_PG_PORT ?? String(portSeed + 4)
const fakeOAuthPort = process.env.XIHE_FAKE_OAUTH_PORT ?? String(portSeed + 10)
const fakeMcpPort = process.env.XIHE_FAKE_MCP_PORT ?? String(portSeed + 11)
const fakeMcpAccessToken = process.env.XIHE_FAKE_MCP_ACCESS_TOKEN ?? `e2e-${randomBytes(24).toString('hex')}`
process.env.XIHE_REMOTE_MCP_ALLOW_INSECURE_LOCAL ??= 'true'
process.env.XIHE_CP_API_TOKEN ??= `e2e-${randomBytes(24).toString('hex')}`
process.env.XIHE_E2E_EXTERNAL_SERVER = 'true'
const e2eProfile = process.env.XIHE_E2E_PROFILE ?? 'compose'
if (e2eProfile !== 'compose') {
  throw new Error('scripts/e2e-real.mjs only supports the compose profile; run host E2E against an active dev:host stack')
}
// Export resolved isolated ports so docker-compose port bindings use them too
process.env.XIHE_UI_PORT = uiPort
process.env.XIHE_CP_PORT = cpPort
process.env.XIHE_AGENT_PORT = agentPort
process.env.XIHE_RUNTIME_PORT = runtimePort
process.env.XIHE_PG_PORT = pgPort
const projectName = `xihe-e2e-${Date.now()}-${process.pid}`
let noBuild = process.argv.includes('--no-build')
const noCache = process.argv.includes('--no-cache')
const keep = process.argv.includes('--keep')
const playwrightArgs = process.argv.slice(2).filter(
  (arg) => !['--no-build', '--no-cache', '--keep'].includes(arg),
)
const playwrightTestArgs = playwrightArgs.length > 0 ? playwrightArgs : ['e2e/real']

const command = process.platform === 'win32' ? 'docker.exe' : 'docker'
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
let uiProcess
const fixtureProcesses = []
let cleaned = false
let activeCleanup
let shuttingDown = false

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
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }))
  })
}

async function runChecked(program, args, options = {}) {
  const result = await run(program, args, options)
  if (result.code !== 0) {
    throw new Error(`${program} ${args.join(' ')} exited with code ${result.code}`)
  }
  return result
}

async function waitForHttp(name, url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'not ready'
  while (Date.now() < deadline) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (response.ok) {
        console.log(`[e2e] ${name} ready: ${url}`)
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`${name} did not become ready within ${timeoutMs}ms (${lastError})`)
}

async function waitForPostgres(composeArgs, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await run(command, [...composeArgs, 'exec', '-T', 'postgres', 'pg_isready', '-U', 'xihe', '-d', 'xihe'], {
      stdio: 'ignore',
    })
    if (result.code === 0) {
      console.log('[e2e] PostgreSQL ready')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`PostgreSQL did not become ready within ${timeoutMs}ms`)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  if (process.platform === 'win32') {
    await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}

async function cleanup(composeArgs) {
  if (cleaned) return
  cleaned = true
  await stopProcess(uiProcess)
  await Promise.all(fixtureProcesses.map((child) => stopProcess(child)))
  if (!keep) {
    await run(command, [...composeArgs, 'down', '--volumes', '--remove-orphans'], { stdio: 'inherit' })
  } else {
    console.log(`[e2e] keeping Docker project ${projectName}`)
  }
}

async function dumpLogs(composeArgs) {
  console.error('[e2e] collecting Docker service logs')
  await run(command, [...composeArgs, 'logs', '--no-color', '--timestamps', '--tail', '300'], { stdio: 'inherit' })
}

async function main() {
  const composeArgs = ['compose', '-p', projectName, '-f', composeFile]
  activeCleanup = () => cleanup(composeArgs)
  const composeServices = ['postgres', 'control-plane', 'agent', 'runtime']
  let testCode = 1
  try {
    console.log(`[e2e] starting Docker project ${projectName}`)
    if (noBuild) {
      const missingImages = []
      for (const service of composeServices) {
        const image = `${projectName}-${service}:latest`
        const result = await run(command, ['image', 'inspect', image], { stdio: 'ignore' })
        if (result.code !== 0) missingImages.push(image)
      }
      if (missingImages.length > 0) {
        console.log('[e2e] --no-build requested but this isolated project has no cached service images; falling back to build')
        noBuild = false
      }
    }
    if (noCache) {
      await runChecked(command, [...composeArgs, 'build', '--no-cache', ...composeServices])
    }
    await runChecked(command, [
      ...composeArgs,
      'up',
      '-d',
      noBuild || noCache ? '--no-build' : '--build',
      ...composeServices,
    ])
    await waitForPostgres(composeArgs)
    await waitForHttp('Control Plane', `http://localhost:${cpPort}/actuator/health`)
    await waitForHttp('Agent', `http://localhost:${agentPort}/internal/v1/agent/health`)
    await waitForHttp('Runtime', `http://localhost:${runtimePort}/health`)

    for (const [name, script, port, env] of [
      ['Fake OAuth', 'fake-oauth-server.mjs', fakeOAuthPort, { XIHE_FAKE_OAUTH_PORT: fakeOAuthPort }],
      ['Fake MCP', 'fake-mcp-server.mjs', fakeMcpPort, {
        XIHE_FAKE_MCP_PORT: fakeMcpPort,
        XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
      }],
    ]) {
      const fixture = spawnCommand(process.execPath, [join(uiDir, 'e2e', 'fixtures', script)], {
        cwd: projectDir,
        env: { ...process.env, ...env },
        stdio: 'inherit',
        windowsHide: true,
      })
      fixtureProcesses.push(fixture)
      fixture.once('error', (error) => console.error(`[e2e] ${name} process error: ${error.message}`))
      await waitForHttp(name, `http://localhost:${port}/health`)
    }

    uiProcess = spawnCommand(pnpmCommand, ['run', 'dev'], {
      cwd: uiDir,
      env: { ...process.env, XIHE_UI_PORT: uiPort },
      stdio: 'inherit',
      windowsHide: true,
    })
    uiProcess.once('error', (error) => console.error(`[e2e] UI process error: ${error.message}`))
    await waitForHttp('UI', `http://localhost:${uiPort}`)

    const result = await run(pnpmCommand, [
      'exec',
      'playwright',
      'test',
      '--config',
      'e2e/playwright.config.ts',
      ...playwrightTestArgs,
    ], {
      cwd: uiDir,
      env: {
        XIHE_E2E_PROFILE: e2eProfile,
        XIHE_UI_PORT: uiPort,
        XIHE_CP_PORT: cpPort,
        XIHE_AGENT_PORT: agentPort,
        XIHE_RUNTIME_PORT: runtimePort,
        XIHE_FAKE_OAUTH_PORT: fakeOAuthPort,
        XIHE_FAKE_MCP_PORT: fakeMcpPort,
        XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
        XIHE_E2E_EXTERNAL_SERVER: '1',
      },
    })
    testCode = result.code
    if (testCode !== 0) await dumpLogs(composeArgs)
  } catch (error) {
    await dumpLogs(composeArgs)
    throw error
  } finally {
    await cleanup(composeArgs)
  }
  process.exitCode = testCode
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    if (shuttingDown) return
    shuttingDown = true
    process.exitCode = 130
    if (activeCleanup) await activeCleanup()
    process.exit(130)
  })
}

main().catch(async (error) => {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
