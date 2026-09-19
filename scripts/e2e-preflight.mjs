#!/usr/bin/env node
// XH host E2E preflight — read-only. Answers one question before a host E2E
// window: "is the machine able to start a clean, isolated run right now?"
//
// It never mutates anything: no docker rm/down, no file writes, no process
// kills. Findings are printed and summarised; the exit code tells a caller
// whether something needs handling.
//
// Usage:
//   node scripts/e2e-preflight.mjs [--ports=27000-28020[,A-B...]] [--logs=8] [--strict]
//
//   --ports=A-B   replace the default e2e port block (repeat/comma-separate to
//                 add more ranges). The five xihe dev ports are always checked.
//   --logs=N      how many recent .local/dev entries to print (default 8).
//   --strict      also fail (exit 1) on warnings, not only on blocking findings.
//
// Exit codes: 0 = no blocking finding; 1 = needs handling; 2 = usage error.
//
// Checked:
//   1. docker residue   leftover xihe-e2e-* containers/volumes/networks from
//                       interrupted runs, plus e2e-labelled sandbox containers.
//   2. port conflicts   listeners inside the e2e block and on the dev ports
//                       (12630-12634; 12633 in particular blocks `cargo run`
//                       for the host runtime with a binary lock).
//   3. build freshness  control-plane fat jar vs source mtime (the runner
//                       boots any existing jar without a freshness check),
//                       runtime debug binary vs source, cargo lock files.
//   4. run digest       recent .local/dev logs, live/stale runner pid files,
//                       Playwright .last-run.json and the newest JSON report.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const projectDir = dirname(import.meta.dirname)
const isWindows = process.platform === 'win32'

// e2e-host.mjs derives its block as 27000 + (hash(runId) % 1500) and uses
// offsets +0..+4 (services) and +10..+12 (fixtures); port 27339 is OS-excluded
// and the runner shifts its block around it, so a listener there is irrelevant.
const E2E_BASE_MIN = 27000
const E2E_BASE_COUNT = 1500
const E2E_MAX_OFFSET = 12
const E2E_DEFAULT_RANGE = [E2E_BASE_MIN, E2E_BASE_MIN + E2E_BASE_COUNT - 1 + E2E_MAX_OFFSET]
const devPorts = [
  { port: 12630, name: 'ui', blocking: false },
  { port: 12631, name: 'cp', blocking: false },
  { port: 12632, name: 'agent', blocking: false },
  { port: 12633, name: 'runtime', blocking: true },
  { port: 12634, name: 'postgres', blocking: false },
]

let e2eRanges = null
let portsCustomized = false
let logCount = 8
let strict = false
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 27).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
    process.exit(0)
  } else if (arg === '--strict') {
    strict = true
  } else if (arg.startsWith('--logs=')) {
    logCount = Number(arg.slice('--logs='.length))
    if (!Number.isInteger(logCount) || logCount < 1 || logCount > 50) usage(`invalid --logs: ${arg}`)
  } else if (arg.startsWith('--ports=')) {
    const parsed = []
    for (const part of arg.slice('--ports='.length).split(',')) {
      const match = /^(\d+)-(\d+)$/.exec(part.trim())
      if (!match || Number(match[1]) > Number(match[2])) usage(`invalid --ports range: ${part}`)
      parsed.push([Number(match[1]), Number(match[2])])
    }
    e2eRanges = [...(e2eRanges ?? []), ...parsed]
    portsCustomized = true
  } else {
    usage(`unknown argument: ${arg}`)
  }
}
if (!e2eRanges) e2eRanges = [E2E_DEFAULT_RANGE]

function usage(message) {
  console.error(`e2e-preflight: ${message}`)
  console.error('usage: node scripts/e2e-preflight.mjs [--ports=A-B[,A-B]] [--logs=N] [--strict]')
  process.exit(2)
}

const findings = []
function add(severity, scope, message, hint) {
  findings.push({ severity, scope, message, hint })
}
function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 120) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MiB`
}
function runCapture(program, args, timeoutMs = 20000) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error) return { ok: false, code: null, stdout: '', stderr: String(result.error.message ?? result.error) }
  return { ok: result.status === 0, code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function newestMtime(root, skipDirs = ['node_modules', 'target', '.git']) {
  let newest = { path: null, mtimeMs: 0 }
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name)) stack.push(full)
      } else if (entry.isFile()) {
        try {
          const stat = statSync(full)
          if (stat.mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs: stat.mtimeMs }
        } catch {
          // unreadable entry: not a finding for a read-only preflight
        }
      }
    }
  }
  return newest
}
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

const now = Date.now()
console.log(`XH host E2E preflight (read-only)  ${new Date(now).toISOString()}`)
console.log(`project: ${projectDir}`)
console.log(`e2e port block: ${e2eRanges.map(([a, b]) => `${a}-${b}`).join(', ')}${portsCustomized ? '  (custom)' : '  (27000 + hash(runId)%1500, offsets 0-4 & 10-12)'}`)
console.log(`dev ports: ${devPorts.map((p) => p.port).join(', ')}`)
console.log('')

// ---------------------------------------------------------------- 1. docker
console.log('[1/4] docker residue')
const dockerCmd = isWindows ? 'docker.exe' : 'docker'
const dockerVersion = runCapture(dockerCmd, ['version', '--format', '{{.Server.Version}}'], 15000)
if (!dockerVersion.ok) {
  add('FAIL', 'docker', 'docker is not reachable (host E2E needs Docker Desktop with WSL2)', dockerVersion.stderr.trim().split('\n')[0])
  console.log(`  FAIL  docker not reachable: ${dockerVersion.stderr.trim().split('\n')[0] ?? 'unknown error'}`)
} else {
  console.log(`  OK    docker server ${dockerVersion.stdout.trim()}`)
  const ps = runCapture(dockerCmd, ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Labels}}'])
  const volumes = runCapture(dockerCmd, ['volume', 'ls', '--format', '{{.Name}}'])
  const networks = runCapture(dockerCmd, ['network', 'ls', '--format', '{{.Name}}'])
  const residueContainers = []
  const e2eSandboxes = []
  const devSandboxes = []
  if (ps.ok) {
    for (const line of ps.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [name, status = '', labels = ''] = line.split('\t')
      if (name.startsWith('xihe-e2e-')) residueContainers.push({ name, status })
      else if (name.startsWith('xihe-workspace-')) {
        if (labels.includes('xihe.e2e.run-id=')) e2eSandboxes.push({ name, status })
        else devSandboxes.push({ name, status })
      }
    }
  } else {
    add('FAIL', 'docker', 'cannot list containers (`docker ps -a` failed)', ps.stderr.trim().split('\n')[0])
  }
  const residueVolumes = volumes.ok ? volumes.stdout.split('\n').map((l) => l.trim()).filter((n) => n.startsWith('xihe-e2e-')) : []
  const residueNetworks = networks.ok ? networks.stdout.split('\n').map((l) => l.trim()).filter((n) => n.startsWith('xihe-e2e-')) : []
  if (residueContainers.length > 0) {
    add('FAIL', 'docker', `${residueContainers.length} residual xihe-e2e-* container(s)`, 'interrupted run; tear down before starting a new one (or reuse via XIHE_E2E_EXTERNAL_SERVER=1)')
    for (const item of residueContainers) console.log(`  FAIL  container ${item.name} (${item.status})`)
  }
  if (e2eSandboxes.length > 0) {
    add('FAIL', 'docker', `${e2eSandboxes.length} e2e-labelled sandbox container(s) (label xihe.e2e.run-id)`, 'leftover Sandbox from a failed run; remove after confirming no live run')
    for (const item of e2eSandboxes) console.log(`  FAIL  sandbox ${item.name} (${item.status})`)
  }
  if (residueVolumes.length > 0) {
    add('FAIL', 'docker', `${residueVolumes.length} residual e2e volume(s)`, residueVolumes.join(', '))
    console.log(`  FAIL  volume ${residueVolumes.join(', ')}`)
  }
  if (residueNetworks.length > 0) {
    add('FAIL', 'docker', `${residueNetworks.length} residual e2e network(s)`, residueNetworks.join(', '))
    console.log(`  FAIL  network ${residueNetworks.join(', ')}`)
  }
  if (residueContainers.length === 0 && e2eSandboxes.length === 0 && residueVolumes.length === 0 && residueNetworks.length === 0) {
    console.log('  OK    no residual xihe-e2e-* containers/volumes/networks, no e2e-labelled sandboxes')
  }
  for (const item of devSandboxes) {
    console.log(`  INFO  dev sandbox ${item.name} (${item.status}) — not e2e-carried; do not remove blindly`)
  }
}
console.log('')

// ----------------------------------------------------------------- 2. ports
console.log('[2/4] listening ports')
const listenFindings = queryListeners(e2eRanges, devPorts)
if (listenFindings === null) {
  add('WARN', 'ports', 'could not query listeners; port conflicts were not verified')
  console.log('  WARN  could not enumerate listeners on this platform/shell')
} else if (listenFindings.length === 0) {
  console.log(`  OK    no listeners inside ${e2eRanges.map(([a, b]) => `${a}-${b}`).join(', ')} or on the dev ports`)
} else {
  for (const item of listenFindings) {
    const inE2eBlock = e2eRanges.some(([a, b]) => item.port >= a && item.port <= b)
    const dev = devPorts.find((p) => p.port === item.port)
    const detail = `port ${item.port} (${item.address || '?'}) held by pid ${item.pid} ${item.process || ''}`.trim()
    if (inE2eBlock) {
      add('FAIL', 'ports', detail, 'e2e block must be free: a live run may own it, or a service leaked; do not start a second run')
      console.log(`  FAIL  ${detail} — inside the e2e block`)
    } else if (dev?.blocking) {
      add('FAIL', 'ports', `${detail} — dev runtime blocks cargo-run (binary lock, os error 5)`, 'stop the dev runtime first: mise run dev:host:stop')
      console.log(`  FAIL  ${detail} — dev runtime binary lock`)
    } else {
      console.log(`  INFO  ${detail} — ${dev ? `daily dev ${dev.name} stack` : 'outside configured ranges'}; not used by an isolated e2e run`)
    }
  }
}
console.log('')

// ------------------------------------------------------------- 3. artifacts
console.log('[3/4] build artifacts (source mtime vs artifact mtime)')
const cpDir = join(projectDir, 'packages', 'control-plane')
const cpTarget = join(cpDir, 'target')
let cpJar = null
if (existsSync(cpTarget)) {
  for (const name of readdirSync(cpTarget)) {
    if (/^control-plane-.*\.jar$/.test(name)) {
      const stat = statSync(join(cpTarget, name))
      if (!cpJar || stat.mtimeMs > cpJar.mtimeMs) cpJar = { path: join(cpTarget, name), name, mtimeMs: stat.mtimeMs }
    }
  }
}
if (!cpJar) {
  console.log('  INFO  control-plane: no fat jar in target/ — the runner will use `mvn spring-boot:run` (no stale-jar risk)')
} else {
  const cpSource = newestMtime(join(cpDir, 'src', 'main'))
  const pomStat = existsSync(join(cpDir, 'pom.xml')) ? statSync(join(cpDir, 'pom.xml')) : { mtimeMs: 0, path: null }
  const newestSource = cpSource.mtimeMs > pomStat.mtimeMs ? cpSource : { path: join(cpDir, 'pom.xml'), mtimeMs: pomStat.mtimeMs }
  if (newestSource.mtimeMs > cpJar.mtimeMs) {
    add('FAIL', 'build', `CP jar is older than CP sources by ${fmtAge(newestSource.mtimeMs - cpJar.mtimeMs)}`, `runner boots any existing jar without a freshness check; rebuild: cd packages/control-plane && mvn -q -DskipTests package`)
    console.log(`  FAIL  CP jar ${cpJar.name} (${fmtAge(now - cpJar.mtimeMs)} old) is STALE vs ${newestSource.path} (${fmtAge(now - newestSource.mtimeMs)} old)`)
  } else {
    console.log(`  OK    CP jar ${cpJar.name} (${fmtAge(now - cpJar.mtimeMs)} old) is newer than CP sources`)
  }
}
const runtimeDir = join(projectDir, 'packages', 'runtime')
const runtimeDebug = join(runtimeDir, 'target', 'debug', isWindows ? 'xihe-runtime.exe' : 'xihe-runtime')
const runtimeRelease = join(runtimeDir, 'target', 'release', isWindows ? 'xihe-runtime.exe' : 'xihe-runtime')
const runtimeSourceNewest = (() => {
  let newest = newestMtime(join(runtimeDir, 'src'))
  for (const extra of ['Cargo.toml', 'Cargo.lock']) {
    const path = join(runtimeDir, extra)
    if (existsSync(path)) {
      const stat = statSync(path)
      if (stat.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: stat.mtimeMs }
    }
  }
  return newest
})()
if (existsSync(runtimeDebug)) {
  const stat = statSync(runtimeDebug)
  if (runtimeSourceNewest.mtimeMs > stat.mtimeMs) {
    add('WARN', 'build', `runtime debug binary is older than runtime sources by ${fmtAge(runtimeSourceNewest.mtimeMs - stat.mtimeMs)}`, '`cargo run` will rebuild first (minutes); prebuild to keep the window short')
    console.log(`  WARN  runtime debug binary (${fmtAge(now - stat.mtimeMs)} old) is stale vs ${runtimeSourceNewest.path} — cargo will rebuild it`)
  } else {
    console.log(`  OK    runtime debug binary (${fmtAge(now - stat.mtimeMs)} old) is newer than runtime sources`)
  }
} else {
  console.log('  INFO  runtime debug binary missing — first `cargo run` will build it')
}
if (existsSync(runtimeRelease)) {
  console.log(`  INFO  runtime release binary present (${fmtAge(now - statSync(runtimeRelease).mtimeMs)} old) — host E2E uses the debug binary`)
}
const lockHits = []
for (const dir of [join(runtimeDir, 'target', 'debug'), join(runtimeDir, 'target', 'release'), cpTarget]) {
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir)) {
    if (name === '.cargo-lock' || name === '.cargo-build-lock' || name === '.cargo-artifact-lock' || name.endsWith('.lock')) {
      lockHits.push({ path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs })
    }
  }
}
if (lockHits.length > 0) {
  const recent = lockHits.filter((hit) => now - hit.mtimeMs < 15 * 60 * 1000)
  if (recent.length > 0) {
    add('WARN', 'build', `lock file(s) touched in the last 15 min (${recent.map((h) => h.path.split(/[\\/]/).pop()).join(', ')})`, 'a build may be running now; do not start a second cargo/maven build')
  }
  console.log(`  INFO  lock files present (${lockHits.length}): ${lockHits.map((h) => `${h.path.split(/[\\/]/).pop()}(${fmtAge(now - h.mtimeMs)})`).join(', ')} — cargo keeps these files; only recent mtime means an active build`)
}
console.log('')

// --------------------------------------------------------------- 4. digest
console.log('[4/4] recent runs (.local/dev + Playwright last run)')
const devDir = join(projectDir, '.local', 'dev')
if (!existsSync(devDir)) {
  console.log('  INFO  .local/dev does not exist yet (no host runs recorded here)')
} else {
  const entries = readdirSync(devDir).map((name) => {
    const stat = statSync(join(devDir, name))
    return { name, mtimeMs: stat.mtimeMs, size: stat.size, isFile: stat.isFile() }
  }).filter((e) => e.isFile).sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, logCount)
  for (const entry of entries) {
    console.log(`  INFO  ${entry.name}  ${fmtAge(now - entry.mtimeMs)} old  ${fmtSize(entry.size)}`)
  }
  const logs = readdirSync(devDir).filter((name) => /^host-e2e-.*\.log$/.test(name)).map((name) => ({ name, mtimeMs: statSync(join(devDir, name)).mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const newestLog = logs[0]
  if (newestLog) {
    const pidFile = join(devDir, `${newestLog.name}.pid`)
    if (existsSync(pidFile)) {
      const rawPid = Number(readFileSync(pidFile, 'utf8').trim())
      const alive = pidAlive(rawPid)
      if (alive) {
        add('FAIL', 'runs', `newest host-e2e log ${newestLog.name} has a live runner pid ${rawPid} (${fmtAge(now - newestLog.mtimeMs)} since last log write)`, 'another host E2E run appears active — do not start a second one; wait for teardown or check the log')
        console.log(`  FAIL  newest log ${newestLog.name} looks ACTIVE (pid ${rawPid} alive, last write ${fmtAge(now - newestLog.mtimeMs)} ago)`)
      } else {
        add('WARN', 'runs', `stale runner pid file for ${newestLog.name} (pid ${rawPid} not a live node process)`, 'previous run ended or was reaped; safe to ignore, remove the .pid when tidying')
        console.log(`  WARN  newest log ${newestLog.name}: pid file stale (pid ${rawPid} not a live node process)`)
      }
    } else {
      console.log(`  INFO  newest host-e2e log ${newestLog.name} (${fmtAge(now - newestLog.mtimeMs)} old, no pid file)`)
    }
  }
  const lastRunPath = join(projectDir, 'packages', 'ui', 'test-results', '.last-run.json')
  if (existsSync(lastRunPath)) {
    const lastRun = readJson(lastRunPath)
    if (lastRun) {
      const failed = Array.isArray(lastRun.failedTests) ? lastRun.failedTests : []
      console.log(`  INFO  playwright .last-run.json: status=${lastRun.status ?? '?'} failedTests=${failed.length}${failed.length > 0 ? ` (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ', …' : ''})` : ''}`)
    }
  } else {
    console.log('  INFO  packages/ui/test-results/.last-run.json not present')
  }
  const reports = readdirSync(devDir).filter((name) => /results.*\.json$/i.test(name)).map((name) => ({ name, mtimeMs: statSync(join(devDir, name)).mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (reports[0]) {
    const report = readJson(join(devDir, reports[0].name))
    const stats = report?.stats
    if (stats) {
      const parts = [`expected=${stats.expected ?? '?'}`, `unexpected=${stats.unexpected ?? '?'}`, `skipped=${stats.skipped ?? '?'}`, `flaky=${stats.flaky ?? '?'}`]
      if (typeof stats.duration === 'number') parts.push(`duration=${Math.round(stats.duration / 1000)}s`)
      console.log(`  INFO  newest JSON report ${reports[0].name} (${fmtAge(now - reports[0].mtimeMs)} old): ${parts.join(' ')}`)
    } else {
      console.log(`  INFO  newest JSON report ${reports[0].name} (${fmtAge(now - reports[0].mtimeMs)} old; no stats block)`)
    }
  }
}
console.log('')

// -------------------------------------------------------------- summary
const failCount = findings.filter((f) => f.severity === 'FAIL').length
const warnCount = findings.filter((f) => f.severity === 'WARN').length
console.log(`findings: ${failCount} blocking / ${warnCount} warning`)
for (const finding of findings.filter((f) => f.severity === 'FAIL' || f.severity === 'WARN')) {
  console.log(`  ${finding.severity}  [${finding.scope}] ${finding.message}${finding.hint ? ` — ${finding.hint}` : ''}`)
}
const needsHandling = failCount > 0 || (strict && warnCount > 0)
console.log(needsHandling ? 'verdict: NEEDS HANDLING' : 'verdict: OK')

// Platform-specific listener enumeration. Returns null when it cannot answer
// (read-only best effort; never guesses).
function queryListeners(ranges, dev) {
  const wanted = new Set()
  for (const [a, b] of ranges) for (let p = a; p <= b; p += 1) wanted.add(p)
  for (const entry of dev) wanted.add(entry.port)
  if (isWindows) {
    const rangeLiteral = ranges.map(([a, b]) => `@(${a},${b})`).join(', ')
    const script = [
      `$ranges = @(${rangeLiteral})`,
      '$hits = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {',
      '  $p = $_.LocalPort',
      '  ($ranges | Where-Object { $p -ge $_[0] -and $p -le $_[1] }).Count -gt 0',
      '} | ForEach-Object {',
      '  $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue',
      "  [pscustomobject]@{ port = $_.LocalPort; address = $_.LocalAddress; pid = $_.OwningProcess; process = $(if ($proc) { $proc.ProcessName } else { 'unknown' }) }",
      '}',
      'ConvertTo-Json -InputObject @($hits) -Compress',
    ].join('\n')
    const result = runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 30000)
    if (!result.ok) return null
    const trimmed = result.stdout.trim()
    if (!trimmed) return []
    try {
      const parsed = JSON.parse(trimmed)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return list.filter((item) => wanted.has(Number(item.port))).map((item) => ({
        port: Number(item.port),
        address: item.address,
        pid: item.pid,
        process: item.process,
      }))
    } catch {
      return null
    }
  }
  const netstat = runCapture('netstat', isWindows ? ['-ano'] : ['-ltnp'], 20000)
  if (!netstat.ok) return null
  const hits = []
  for (const line of netstat.stdout.split('\n')) {
    const match = isWindows
      ? /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line)
      : /LISTEN\s+\d+\s+\d+\s+\S*?:(\d+)\s+.*?(?:pid=(\d+))?/.exec(line)
    if (!match) continue
    const port = Number(match[1])
    if (wanted.has(port)) hits.push({ port, address: '', pid: match[2] ?? '?', process: '' })
  }
  return hits
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (isWindows) {
    const result = runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`], 10000)
    if (!result.ok) return false
    return /node/i.test(result.stdout.trim())
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

process.exit(needsHandling ? 1 : 0)
