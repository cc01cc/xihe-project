#!/usr/bin/env node
// Fixture: XH host E2E detached launcher (PLAN-0344 / session-retrospect 2026-09-18).
//
// Why: long-running `background_process` entries can be reaped mid-flight by the
// session supervisor (no exit code, log stops). This launcher spawns the runner
// fully detached with stdio redirected to a log file, writes a pid file, spawns
// a watchdog that kills the process tree on timeout, then exits immediately.
//
// Usage:
//   node scripts/e2e-host-detached.mjs [--timeout-min 30] [--log <path>] [runner args...]
//     runner args are passed to scripts/e2e-host.mjs verbatim
//       e.g. --retries=0 e2e/real/job-resume.spec.ts --llm-mode=job
// Outputs:
//   log: <repo>/.local/dev/host-e2e-<ts>.log  (override with --log)
//   pid: same path with .pid suffix
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(scriptDir, '..')

const argv = process.argv.slice(2)

// Watchdog mode: node e2e-host-detached.mjs --watch <pid> <timeoutSecs> <log>
if (argv[0] === '--watch') {
  const [, pidRaw, timeoutRaw, logPath] = argv
  const pid = Number(pidRaw)
  const timeoutMs = Number(timeoutRaw) * 1000
  const startedAt = Date.now()
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  const tick = setInterval(() => {
    if (!alive()) {
      appendFileSync(logPath, `[watchdog] child pid=${pid} exited after ${Math.round((Date.now() - startedAt) / 1000)}s\n`)
      clearInterval(tick)
      process.exit(0)
    }
    if (Date.now() - startedAt > timeoutMs) {
      appendFileSync(logPath, `[watchdog] timeout after ${timeoutRaw}s; killing process tree pid=${pid}\n`)
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          process.kill(pid, 'SIGKILL')
        }
      }
      clearInterval(tick)
      process.exit(2)
    }
  }, 15000)
} else {
  let timeoutMin = 30
  let logPath = ''
  const passthrough = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--timeout-min') {
      timeoutMin = Number(argv[++i] ?? '30')
    } else if (arg === '--log') {
      logPath = argv[++i] ?? ''
    } else {
      passthrough.push(arg)
    }
  }
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  if (!logPath) {
    logPath = path.join(repo, '.local', 'dev', `host-e2e-${stamp}.log`)
  }
  mkdirSync(path.dirname(logPath), { recursive: true })
  writeFileSync(logPath, '')
  const out = openSync(logPath, 'a')

  const child = spawn(process.execPath, ['scripts/e2e-host.mjs', ...passthrough], {
    cwd: repo,
    stdio: ['ignore', out, out],
    detached: true,
    windowsHide: true,
  })
  child.unref()
  writeFileSync(`${logPath}.pid`, String(child.pid))

  const watchdog = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), '--watch', String(child.pid), String(timeoutMin * 60), logPath],
    { cwd: repo, stdio: 'ignore', detached: true, windowsHide: true },
  )
  watchdog.unref()

  appendFileSync(logPath, `[launcher] runner pid=${child.pid} watchdog pid=${watchdog.pid} timeout=${timeoutMin}min\n`)
  console.log(`runner pid=${child.pid}`)
  console.log(`log=${logPath}`)
  console.log(`pid=${logPath}.pid`)
}
