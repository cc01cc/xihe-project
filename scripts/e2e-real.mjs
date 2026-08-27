import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const projectDir = dirname(import.meta.dirname)
const uiDir = join(projectDir, 'packages', 'ui')
const composeFile = join(projectDir, 'docker-compose.yml')
const uiPort = process.env.XIHE_UI_PORT ?? '12630'
const cpPort = process.env.XIHE_CP_PORT ?? '12631'
const agentPort = process.env.XIHE_AGENT_PORT ?? '12632'
const runtimePort = process.env.XIHE_RUNTIME_PORT ?? '12633'
const projectName = `xihe-e2e-${Date.now()}-${process.pid}`
const noBuild = process.argv.includes('--no-build')
const keep = process.argv.includes('--keep')

const command = process.platform === 'win32' ? 'docker.exe' : 'docker'
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
let uiProcess
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
  if (!keep) {
    await run(command, [...composeArgs, 'down', '--volumes', '--remove-orphans'], { stdio: 'inherit' })
  } else {
    console.log(`[e2e] keeping Docker project ${projectName}`)
  }
}

async function dumpLogs(composeArgs) {
  console.error('[e2e] collecting Docker service logs')
  await run(command, [...composeArgs, 'logs', '--no-color', '--timestamps'], { stdio: 'inherit' })
}

async function main() {
  const composeArgs = ['compose', '-p', projectName, '-f', composeFile]
  activeCleanup = () => cleanup(composeArgs)
  const composeServices = ['postgres', 'control-plane', 'agent', 'runtime']
  let testCode = 1
  try {
    console.log(`[e2e] starting Docker project ${projectName}`)
    await runChecked(command, [
      ...composeArgs,
      'up',
      '-d',
      noBuild ? '--no-build' : '--build',
      ...composeServices,
    ])
    await waitForPostgres(composeArgs)
    await waitForHttp('Control Plane', `http://localhost:${cpPort}/actuator/health`)
    await waitForHttp('Agent', `http://localhost:${agentPort}/health`)
    await waitForHttp('Runtime', `http://localhost:${runtimePort}/health`)

    uiProcess = spawnCommand(pnpmCommand, ['run', 'dev'], {
      cwd: uiDir,
      env: { ...process.env, XIHE_UI_PORT: uiPort },
      stdio: 'inherit',
      windowsHide: true,
    })
    uiProcess.once('error', (error) => console.error(`[e2e] UI process error: ${error.message}`))
    await waitForHttp('UI', `http://localhost:${uiPort}`)

    const result = await run(pnpmCommand, ['exec', 'playwright', 'test', '--config', 'e2e/playwright.config.ts', 'e2e/real'], {
      cwd: uiDir,
      env: {
        XIHE_UI_PORT: uiPort,
        XIHE_CP_PORT: cpPort,
        XIHE_AGENT_PORT: agentPort,
        XIHE_RUNTIME_PORT: runtimePort,
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
