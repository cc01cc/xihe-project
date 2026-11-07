#!/usr/bin/env node
// XH host E2E preflight — read-only. Answers one question before a host E2E
// window: "is the machine able to start a clean, isolated run right now?"
//
// It never mutates anything: no docker rm/down, no file writes, no process
// kills. Findings are printed and summarised; the exit code tells a caller
// whether something needs handling.
//
// Usage:
//   node scripts/e2e-preflight.mjs [--ports=27000-28020[,A-B...]] [--logs=8] [--strict] [--ignore-build] [--disk-only] [--self-pid=N]
//
//   --ports=A-B    replace the default e2e port block (repeat/comma-separate to
//                  add more ranges). The five xihe dev ports are always checked.
//   --logs=N       how many recent .local/dev entries to print (default 8).
//   --strict       also fail (exit 1) on warnings, not only on blocking findings.
//   --ignore-build skip the CP **fat jar** check in section 3; used by the runner
//                  when the jar will not be booted at all (see
//                  scripts/lib/e2e-preflight-gate.mjs for the exact policy).
//                  The Rust runtime check is NOT skipped: every host E2E run boots
//                  the runtime, so its freshness must stay enforced in every mode
//                  (scope `runtime-target`, always blocking when unknown).
//   --disk-only    run ONLY section 4 (disk headroom) and exit with its verdict.
//                  Used by `e2e-host.mjs --skip-preflight` so that skipping the
//                  rest of the preflight can no longer silently skip the disk
//                  gate (the run header records `diskGate: enforced|bypassed`).
//   --self-pid=N[,M]  the caller's own runner pid(s); a newest-log pid file
//                  matching one of them is the caller's own run (or the
//                  persistent stack it reuses), not a concurrent one.
//   --allow-ports=A,B  listeners on these ports are the caller's own persistent
//                  stack (reuse runs), not a leaked run.
//   --own-run-id=ID    e2e-labelled sandboxes for this run id belong to the
//                  caller's own persistent stack (reuse runs), not residue.
//
// Exit codes: 0 = no blocking finding; 1 = needs handling; 2 = usage error.
//
// Checked:
//   1. docker residue   leftover xihe-e2e-* containers/volumes/networks from
//                       interrupted runs, plus e2e-labelled sandbox containers.
//   2. port conflicts   listeners inside the e2e block and on every registered
//                       XH stack slot (PLAN-0533); any stack's runtime port in
//                       particular blocks `cargo run` for the host runtime.
//   3. build freshness  control-plane fat jar vs **CP source content** (the
//                       runner boots any existing jar without a freshness check),
//                       runtime debug binary vs source, cargo lock files.
//                       Step 0 is the jar's **sidecar fingerprint** (task-90): the
//                       producing script writes `<jar>.buildinfo.json` next to the
//                       artifact with the jar's own sha256 + the CP source-tree
//                       hash + commit + packaging-completion time, so identity is
//                       byte-provable. Priority: sidecar match ⇒ fresh; sidecar
//                       present but the jar's bytes differ ⇒ stale AND
//                       non-deferrable (`artifact-truth`); no sidecar ⇒ the content
//                       path below (identical behaviour to task-84); sidecar
//                       unreadable or the tree hash cannot be recomputed ⇒
//                       unverifiable / fall back (scripts/lib/cp-jar-sidecar.mjs).
//                       Content truth, not mtime (2026-11-08, task-84): the jar
//                       lives outside git so its mtime is honest, but `git
//                       checkout` rewrites tracked-file mtimes, which made the
//                       same jar read red in one checkout and green in another.
//                       Resources the jar stores verbatim are compared by sha256;
//                       compiled sources by last-commit time; unknown is
//                       UNVERIFIABLE and blocking (scripts/lib/e2e-build-artifact.mjs).
//                       The runtime binary is looked up in the target dir cargo
//                       itself resolves (`.cargo/config.toml [build] target-dir`
//                       / CARGO_TARGET_DIR) *including sibling stack dirs*
//                       (`main`, `stack-N`) — never in the deprecated in-tree
//                       `packages/runtime/target`. If that resolution fails the
//                       check is UNVERIFIABLE and blocking (2026-11-08: the old
//                       check read an obsolete binary for days).
//                       Scope split: a stale/resolved jar finding is `build`
//                       (deferrable to the runner's rebuild path, suppressed by
//                       --ignore-build); an unprovable jar is `artifact-truth`
//                       and the runtime finding is `runtime-target` (both never
//                       suppressed — the caller's gate refuses on them in every
//                       jar mode).
//   4. disk headroom    H/C free space before a window (user thresholds,
//                       2026-11-05 — do not change): H < 25% or C < 10% is
//                       blocking, H < 30% is a warning only. An unsampled or
//                       unparsable drive is UNVERIFIABLE and blocking: an
//                       unknown disk state must not open a window. Non-Windows
//                       platforms print `skipped` and never block.
//                       Machine-readable line: `  disk  {"name":"disk",…}`
//                       (see scripts/lib/e2e-preflight-disk.mjs).
//   5. run digest       recent .local/dev logs, live/stale runner pid files,
//                       Playwright .last-run.json and the newest JSON report.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  collectSourcesNewerThan,
  decideArtifactFreshness,
  listJarEntries,
  readDirtyPaths,
  readFileHash,
  readJarEntryHash,
  readPathCommit,
} from './lib/e2e-build-artifact.mjs'
import { readBuildInfo } from './lib/cp-build-info.mjs'
import { evaluateSidecar, resolveArtifactTruth } from './lib/cp-jar-sidecar.mjs'
import {
  DISK_THRESHOLDS,
  diskExitCode,
  evaluateDisks,
  sampleDisksViaPsDrive,
} from './lib/e2e-preflight-disk.mjs'
import { inspectRuntimeBinaries, resolveRuntimeTargetDirs } from './lib/e2e-runtime-target.mjs'

const projectDir = dirname(import.meta.dirname)
const isWindows = process.platform === 'win32'

// e2e-host.mjs derives its block as 27000 + (hash(runId) % 1500) and uses
// offsets +0..+4 (services) and +10..+12 (fixtures); port 27339 is OS-excluded
// and the runner shifts its block around it, so a listener there is irrelevant.
const E2E_BASE_MIN = 27000
const E2E_BASE_COUNT = 1500
const E2E_MAX_OFFSET = 12
const E2E_DEFAULT_RANGE = [E2E_BASE_MIN, E2E_BASE_MIN + E2E_BASE_COUNT - 1 + E2E_MAX_OFFSET]
// HTTP.sys AURASDK reservation; the runner shifts its block around it, so a
// listener there is never an e2e conflict (see e2e-host.mjs portBase).
const OS_EXCLUDED_PORTS = new Set([27339])
// PLAN-0533: dev ports are stack slots, not one fixed block. Derive them from
// scripts/stack-run.mjs (which reads the workspace SSOT) so a second stack's
// ports are reported too; every stack's runtime port is blocking because a
// running dev runtime holds the cargo binary lock for this checkout.
function loadStackSlots() {
  try {
    const output = execFileSync(process.execPath, [join(projectDir, 'scripts', 'stack-run.mjs'), 'slots-json'], {
      encoding: 'utf8',
      timeout: 10_000,
    })
    return JSON.parse(output)
  } catch {
    return []
  }
}
const stackSlots = loadStackSlots()
const currentStackId = process.env.XIHE_STACK_ID || 'stack-1'
const devPorts = stackSlots.length
  ? stackSlots.flatMap((slot) =>
      Object.entries(slot.ports).map(([name, port]) => ({
        port,
        name: `dev-${slot.stackId}-${name}`,
        blocking: name === 'runtime',
      })),
    )
  : [
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
let ignoreBuild = false
let diskOnly = false
const selfPids = new Set()
let ownRunId = ''
const allowedPorts = new Set()
for (const arg of process.argv.slice(2)) {
  if (arg === '--help' || arg === '-h') {
    // The header comment is the help text: print every leading `//` line up to
    // the first blank one (a fixed slice silently truncates the help whenever a
    // check is documented, which is how the disk gate would have gone unseen).
    const header = readFileSync(new URL(import.meta.url), 'utf8').split('\n')
    const headerEnd = header.findIndex((line, index) => index > 0 && line.trim() === '')
    console.log(header.slice(1, headerEnd).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
    process.exit(0)
  } else if (arg === '--strict') {
    strict = true
  } else if (arg === '--ignore-build') {
    ignoreBuild = true
  } else if (arg === '--disk-only') {
    diskOnly = true
  } else if (arg.startsWith('--self-pid=')) {
    for (const part of arg.slice('--self-pid='.length).split(',')) {
      const pid = Number(part.trim())
      if (!Number.isInteger(pid) || pid <= 0) usage(`invalid --self-pid entry: ${part}`)
      selfPids.add(pid)
    }
  } else if (arg.startsWith('--allow-ports=')) {
    for (const part of arg.slice('--allow-ports='.length).split(',')) {
      const port = Number(part.trim())
      if (!Number.isInteger(port) || port <= 0 || port > 65535) usage(`invalid --allow-ports entry: ${part}`)
      allowedPorts.add(port)
    }
  } else if (arg.startsWith('--own-run-id=')) {
    ownRunId = arg.slice('--own-run-id='.length).trim()
    if (!ownRunId) usage(`invalid --own-run-id: ${arg}`)
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
  console.error('usage: node scripts/e2e-preflight.mjs [--ports=A-B[,A-B]] [--logs=N] [--strict] [--ignore-build] [--disk-only] [--self-pid=N]')
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
function runCapture(program, args, timeoutMs = 20000, cwd = undefined) {
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...(cwd ? { cwd } : {}),
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

// `xihe-e2e-host-<runId with punctuation stripped>-postgres-1` — the compose
// project prefix names the run (and therefore the worktree) that owns the
// residue, so the operator can tell "another run is live" from "an interrupted
// run left this behind" before deciding to wait or tear down.
function e2eOwnerOf(name) {
  const prefix = 'xihe-e2e-host-'
  if (!name.startsWith(prefix)) return ''
  return name.slice(prefix.length).replace(/-postgres-1$/, '')
}

const now = Date.now()
console.log(`XH host E2E preflight (read-only)  ${new Date(now).toISOString()}`)
console.log(`project: ${projectDir}`)
console.log(`e2e port block: ${e2eRanges.map(([a, b]) => `${a}-${b}`).join(', ')}${portsCustomized ? '  (custom)' : '  (27000 + hash(runId)%1500, offsets 0-4 & 10-12)'}`)
console.log(`dev ports (current ${currentStackId}): ${devPorts.filter((p) => p.name.startsWith(`dev-${currentStackId}-`)).map((p) => p.port).join(', ')}`)
console.log(`stack slots checked: ${stackSlots.length ? `${stackSlots.length} (runtime ports blocking: ${devPorts.filter((p) => p.blocking).map((p) => p.port).join(', ')})` : 'fallback stack-1 only'}`)
console.log('')

// PLAN-0680 task-76 (defect 2): `--disk-only` exists so a caller that wants to skip
// the rest of the preflight (e2e-host.mjs --skip-preflight) still gets the disk gate.
// Before this flag the only way to skip was to skip *everything*, which is how a
// 12%-free disk could open a window and leave no trace in the run header.
if (diskOnly) {
  const diskOnlyResult = runDiskGate()
  // `--strict` means "warnings also fail", and that must not depend on which
  // sections ran: escalate here instead of relying on the full run's tally.
  process.exit(strict && diskOnlyResult.findings.length > 0 ? 1 : diskExitCode(diskOnlyResult))
}

// ---------------------------------------------------------------- 1. docker
console.log('[1/5] docker residue')
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
  const ownSandboxes = []
  const ownComposeContainers = []
  const devSandboxes = []
  // The runner's compose project is `xihe-e2e-host-<runId without punctuation>`;
  // reuse runs own those containers/volumes/networks (teardown removes them).
  const ownComposePrefix = ownRunId ? `xihe-e2e-host-${ownRunId.replace(/[^a-z0-9]/gi, '').toLowerCase()}` : ''
  if (ps.ok) {
    for (const line of ps.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [name, status = '', labels = ''] = line.split('\t')
      if (name.startsWith('xihe-e2e-')) {
        if (ownComposePrefix && name.toLowerCase().startsWith(ownComposePrefix)) ownComposeContainers.push({ name, status })
        else residueContainers.push({ name, status, owner: e2eOwnerOf(name) })
      } else if (/^xihe-(workspace|ws-s\d+-ws_)/.test(name)) {
        const label = /xihe\.e2e\.run-id=([^,\s]+)/.exec(labels)
        if (label && ownRunId && label[1] === ownRunId) ownSandboxes.push({ name, status })
        else if (labels.includes('xihe.e2e.run-id=')) e2eSandboxes.push({ name, status, owner: label ? label[1] : '' })
        else devSandboxes.push({ name, status })
      }
    }
  } else {
    add('FAIL', 'docker', 'cannot list containers (`docker ps -a` failed)', ps.stderr.trim().split('\n')[0])
  }
  const allE2eVolumes = volumes.ok ? volumes.stdout.split('\n').map((l) => l.trim()).filter((n) => n.startsWith('xihe-e2e-')) : []
  const allE2eNetworks = networks.ok ? networks.stdout.split('\n').map((l) => l.trim()).filter((n) => n.startsWith('xihe-e2e-')) : []
  const ownComposeVolumes = ownComposePrefix ? allE2eVolumes.filter((n) => n.toLowerCase().startsWith(ownComposePrefix)) : []
  const ownComposeNetworks = ownComposePrefix ? allE2eNetworks.filter((n) => n.toLowerCase().startsWith(ownComposePrefix)) : []
  const residueVolumes = allE2eVolumes.filter((n) => !ownComposeVolumes.includes(n))
  const residueNetworks = allE2eNetworks.filter((n) => !ownComposeNetworks.includes(n))
  if (residueContainers.length > 0) {
    add('FAIL', 'docker', `${residueContainers.length} residual xihe-e2e-* container(s)`, 'belongs to another run (or an interrupted one); isolate e2e runs are serial by design. Reuse your own stack via XIHE_E2E_EXTERNAL_SERVER=1, or — only after confirming that run is not live — tear it down from its own worktree (node scripts/e2e-host.mjs --teardown)')
    for (const item of residueContainers) console.log(`  FAIL  container ${item.name} (${item.status})${item.owner ? ` — run ${item.owner}` : ''}`)
  }
  if (e2eSandboxes.length > 0) {
    add('FAIL', 'docker', `${e2eSandboxes.length} e2e-labelled sandbox container(s) (label xihe.e2e.run-id)`, 'leftover Sandbox from a failed run; remove after confirming no live run owns its run id')
    for (const item of e2eSandboxes) console.log(`  FAIL  sandbox ${item.name} (${item.status})${item.owner ? ` — run ${item.owner}` : ''}`)
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
  for (const item of ownComposeContainers) {
    console.log(`  INFO  container ${item.name} (${item.status}) — this caller's own persistent stack; removed by --teardown`)
  }
  if (ownComposeVolumes.length > 0) console.log(`  INFO  volume ${ownComposeVolumes.join(', ')} — this caller's own persistent stack`)
  if (ownComposeNetworks.length > 0) console.log(`  INFO  network ${ownComposeNetworks.join(', ')} — this caller's own persistent stack`)
  for (const item of ownSandboxes) {
    console.log(`  INFO  sandbox ${item.name} (${item.status}) — this caller's own stack run (${ownRunId}); removed by --teardown`)
  }
  for (const item of devSandboxes) {
    console.log(`  INFO  dev sandbox ${item.name} (${item.status}) — not e2e-carried; do not remove blindly`)
  }
}
console.log('')

// ----------------------------------------------------------------- 2. ports
console.log('[2/5] listening ports')
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
      if (allowedPorts.has(item.port)) {
        console.log(`  INFO  ${detail} — this caller's own stack (--allow-ports); not a leaked run`)
      } else {
        add('FAIL', 'ports', detail, 'e2e block must be free: a live run may own it, or a service leaked; do not start a second run')
        console.log(`  FAIL  ${detail} — inside the e2e block`)
      }
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
console.log('[3/5] build artifacts (artifact content vs source truth; mtime is only the trigger)')
const cpDir = join(projectDir, 'packages', 'control-plane')
// PLAN-0656 R2: the runner builds and boots the CP jar from its OWN build dir
// (XIHE_CP_TARGET_DIR, default C:/xihe-build/e2e) — never from the checkout
// target/. The freshness check must look where the runner looks; an in-tree jar
// is not consulted by the default flow.
const e2eCpTargetDir =
  typeof process.env.XIHE_CP_TARGET_DIR === 'string' && process.env.XIHE_CP_TARGET_DIR.trim() !== ''
    ? process.env.XIHE_CP_TARGET_DIR
    : 'C:/xihe-build/e2e'
const cpTarget = e2eCpTargetDir
if (ignoreBuild) {
  console.log(`  INFO  CP artifact freshness skipped (--ignore-build): this run does not boot the jar it would check (dir ${e2eCpTargetDir})`)
} else {
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
  console.log(`  INFO  control-plane: no fat jar in the E2E build dir (${e2eCpTargetDir}) — the runner builds one on first boot (mvn package -Dxihe.target.dir=...; no stale-jar risk)`)
} else {
  // BL-477 / task-90: ask the artifact first. A sidecar manifest (`<jar>.buildinfo.json`) written by
  // the same code path that produced the jar carries the jar's own sha256 plus the CP source-tree
  // hash, so identity is provable without touching mtimes or scanning 8 files one by one.
  const sidecar = evaluateSidecar({ jarPath: cpJar.path, projectDir })
  const truth = resolveArtifactTruth({
    sidecar,
    // BL-477 / task-84 (unchanged when no sidecar exists): `mtime` is the trigger, never the verdict.
    // The jar sits outside git, so its own mtime is honest; tracked files are not — `git checkout`
    // rewrites their mtime even when the content is byte-identical, which made one checkout red and
    // another green over the same jar. Sources newer than the jar are re-judged by content: sha256
    // for the resources the jar stores verbatim, last-commit time for compiled sources (immutable
    // across checkouts). Nothing decidable ⇒ unverifiable ⇒ blocking.
    runFallback: () => {
      const cpPrefix = 'packages/control-plane'
      const sources = collectSourcesNewerThan({
        root: join(cpDir, 'src', 'main'),
        sinceMs: cpJar.mtimeMs,
        prefix: `${cpPrefix}/src/main`,
      })
      const pomPath = join(cpDir, 'pom.xml')
      if (existsSync(pomPath)) {
        const pomStat = statSync(pomPath)
        if (pomStat.mtimeMs > cpJar.mtimeMs) sources.push({ path: `${cpPrefix}/pom.xml`, absPath: pomPath, mtimeMs: pomStat.mtimeMs })
      }
      const dirtyPaths = readDirtyPaths({ projectDir })
      const jarEntries = listJarEntries({ jarPath: cpJar.path })
      return decideArtifactFreshness({
        artifactTimeMs: cpJar.mtimeMs,
        sources,
        readEntryHash: (entry) => readJarEntryHash({ jarPath: cpJar.path, entry }),
        readFileHash: (relPath) => readFileHash({ file: join(projectDir, relPath) }),
        // "not in the jar at all" is stale; "could not list the jar" must stay unknown, not fresh.
        hasEntry: (entry) => (jarEntries.ok ? jarEntries.entries.has(entry) : null),
        // A dirty/untracked read failure must not silently turn into "clean": fail closed instead.
        readCommitState: (relPath) =>
          dirtyPaths.ok
            ? readPathCommit({ projectDir, relPath, dirtyPaths: dirtyPaths.paths })
            : { ok: false, state: 'clean', commit: null, commitTimeMs: null, error: `git status failed: ${dirtyPaths.error}` },
      })
    },
  })
  const stamp = readBuildInfo(cpTarget)
  const shortSha = (sha) => String(sha ?? '').slice(0, 12)
  if (stamp.info) {
    const builtAtMs = Date.parse(stamp.info.builtAt)
    const lag = Number.isFinite(builtAtMs) && builtAtMs < cpJar.mtimeMs ? `, stamped ${fmtAge(cpJar.mtimeMs - builtAtMs)} before the jar was repackaged (stamp under-reports the jar)` : ''
    console.log(
      `  INFO  CP jar provenance: build-info commit ${shortSha(stamp.info.commit)} builtAt ${stamp.info.builtAt || 'unknown'} dirty=${stamp.info.dirty}${lag} — provenance only, not the criterion`,
    )
  } else {
    console.log(`  INFO  CP jar provenance: no build-info stamp in ${e2eCpTargetDir} — the artifact carries no input fingerprint`)
  }
  const rebuildHint = `runner boots any existing jar without a freshness check; rebuild: cd packages/control-plane && mvn -q -DskipTests -Dxihe.target.dir=${e2eCpTargetDir} package`
  if (truth.verdict === 'fresh') {
    // Identity proven: nothing else is consulted (no mtime trigger, no per-file scan).
    const data = sidecar.data
    console.log(
      `  OK    CP jar ${cpJar.name} (${fmtAge(now - cpJar.mtimeMs)} old): byte-identical to the artifact built from ${shortSha(data.commit)}`
        + ` — jar sha256 ${shortSha(data.jarSha256)}…, CP tree ${shortSha(data.sourceTreeSha256)}… (${sidecar.treeEntries} files, built ${data.builtAt})`,
    )
    console.log(`        sidecar ${sidecar.file}: identity + tree both match, content evidence needs no per-file scan`)
  } else if (truth.verdict === 'stale') {
    if (truth.blocking === 'artifact-truth') {
      add(
        'FAIL',
        'artifact-truth',
        `the CP jar is not the artifact its sidecar describes: ${sidecar.reason}`,
        `this is not deferrable — "the jar is not the one we fingerprinted" cannot be explained by sources moving on;`
          + ` a rebuild rewrites jar + sidecar together: node scripts/e2e-host.mjs --jar-mode=rebuild (${rebuildHint})`,
      )
      console.log(`  FAIL  CP jar ${cpJar.name}: IDENTITY MISMATCH — the jar on disk is not the fingerprinted artifact`)
      console.log(`        ${sidecar.reason}`)
      console.log(`        sidecar ${sidecar.file}`)
    } else {
      add(
        'FAIL',
        'build',
        `the CP jar was built from an older CP tree than HEAD: ${sidecar.reason}`,
        rebuildHint,
      )
      console.log(`  FAIL  CP jar ${cpJar.name} (${fmtAge(now - cpJar.mtimeMs)} old) was built from an older CP tree than HEAD`)
      console.log(`        ${sidecar.reason}${Number.isInteger(sidecar.changedCount) ? `; ${sidecar.changedCount} CP file(s) changed since` : ''}`)
      console.log(`        sidecar ${sidecar.file}`)
    }
  } else if (truth.verdict === 'unverifiable') {
    add(
      'FAIL',
      'artifact-truth',
      `cannot prove the CP jar contains the current CP sources: ${sidecar.reason}`,
      'a sidecar that exists but cannot be used is a broken fingerprint, not an excuse to pass'
        + ' (未知不等于安全); rebuild through the runner so it rewrites the sidecar'
        + ` (node scripts/e2e-host.mjs --jar-mode=rebuild) — ${rebuildHint}`,
    )
    console.log(`  FAIL  CP jar ${cpJar.name} (${fmtAge(now - cpJar.mtimeMs)} old) freshness is UNVERIFIABLE`)
    console.log(`        ${sidecar.reason}`)
    console.log(`        sidecar ${sidecar.file}`)
  } else {
    const artifactVerdict = truth.fallback
    // Honest note about which evidence path judged this jar (mirrors the migration contract:
    // artifacts built before task-90, and hand-run `mvn package`, have no sidecar).
    if (sidecar.state === 'missing') {
      console.log(`  INFO  CP jar identity: no sidecar (${sidecar.file}) — judging by content evidence; one runner rebuild adds the fingerprint`)
    } else {
      console.log(`  INFO  CP jar identity: sidecar ${sidecar.file} present but not decisive (${sidecar.reason}) — judging by content evidence`)
    }
    const evidenceCounts = { sha256: 0, membership: 0, 'commit-time': 0, mtime: 0 }
    for (const entry of artifactVerdict.fresh) if (entry.evidence) evidenceCounts[entry.evidence] += 1
    if (artifactVerdict.verdict === 'fresh') {
      if (artifactVerdict.checked === 0) {
        console.log(`  OK    CP jar ${cpJar.name} (${fmtAge(now - cpJar.mtimeMs)} old): no CP source is newer than the jar`)
      } else {
        console.log(
          `  OK    CP jar ${cpJar.name} (${fmtAge(now - cpJar.mtimeMs)} old): ${artifactVerdict.checked} source(s) are newer by mtime but content-identical`
            + ` (${evidenceCounts.sha256} by sha256, ${evidenceCounts['commit-time']} by last-commit time) — mtime was checkout noise`,
        )
        for (const entry of artifactVerdict.fresh.slice(0, 4)) console.log(`        ${entry.path}  ${entry.detail}`)
      }
    } else if (artifactVerdict.verdict === 'stale') {
      add(
        'FAIL',
        'build',
        `CP jar content is older than ${artifactVerdict.stale.length} CP source(s): ${artifactVerdict.stale[0].path} (${artifactVerdict.stale[0].reason})`,
        rebuildHint,
      )
      console.log(
        `  FAIL  CP jar ${cpJar.name} (${fmtAge(now - cpJar.mtimeMs)} old) does NOT contain the current CP sources (${artifactVerdict.stale.length} proven stale of ${artifactVerdict.checked} newer):`,
      )
      for (const entry of artifactVerdict.stale.slice(0, 10)) {
        console.log(`        ${entry.path}  [${entry.evidence}] ${entry.reason}${entry.detail ? ` — ${entry.detail}` : ''}`)
      }
      if (artifactVerdict.stale.length > 10) console.log(`        … and ${artifactVerdict.stale.length - 10} more`)
    } else {
      add(
        'FAIL',
        'artifact-truth',
        `cannot prove the CP jar contains the current CP sources (${artifactVerdict.unverifiable.length} newer source(s) unverifiable): ${artifactVerdict.unverifiable[0].reason}`,
        'the shared jar carries no usable input fingerprint, so a newer-than-jar source with no git/content evidence must block'
          + ' (未知不等于安全); a runner rebuild now writes a sidecar (jar sha256 + CP tree hash) that settles this exactly'
          + ' (see scripts/lib/cp-jar-sidecar.mjs)',
      )
      console.log(
        `  FAIL  CP jar ${cpJar.name} (${fmtAge(now - cpJar.mtimeMs)} old) freshness is UNVERIFIABLE (${artifactVerdict.unverifiable.length} of ${artifactVerdict.checked} newer source(s)):`,
      )
      for (const entry of artifactVerdict.unverifiable.slice(0, 10)) console.log(`        ${entry.path}  ${entry.reason}`)
      if (artifactVerdict.unverifiable.length > 10) console.log(`        … and ${artifactVerdict.unverifiable.length - 10} more`)
    }
  }
}
}
// The Rust runtime is booted by EVERY host E2E run (whatever the CP jar mode is),
// so this check is deliberately OUTSIDE the `--ignore-build` gate and uses its own
// scope: a build-class deferral (`auto` rebuild / `use` / reuse) must not be able to
// wave it through. Unknown freshness here is blocking ("未知不等于安全").
const runtimeDir = join(projectDir, 'packages', 'runtime')
const runtimeBinaryName = isWindows ? 'xihe-runtime.exe' : 'xihe-runtime'
// PLAN-0680 task-76 (defect 3): the freshness check used to read the in-tree
// packages/runtime/target/{debug,release} — a deprecated layout whose binary is
// days older than the one host E2E actually runs. Real runs use
// `.tmp/cargo-target/{main,stack-2}/debug/xihe-runtime.exe`, i.e. whatever
// `.cargo/config.toml [build] target-dir` (or CARGO_TARGET_DIR) resolves to, so
// ask cargo itself (scripts/lib/e2e-runtime-target.mjs) instead of hard-coding.
// Unresolvable ⇒ UNVERIFIABLE **and blocking**: an unknown binary freshness must
// not open a window ("未知不等于安全", same rule as the disk gate).
const runtimeTargets = resolveRuntimeTargetDirs({
  projectRoot: projectDir,
  env: process.env,
  runCapture,
})
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
const runtimeInspection = inspectRuntimeBinaries({
  resolution: runtimeTargets,
  binaryName: runtimeBinaryName,
  sourceNewest: runtimeSourceNewest,
})
if (runtimeInspection.severity) add(runtimeInspection.severity, 'runtime-target', runtimeInspection.message, runtimeInspection.hint)
if (runtimeInspection.status === 'unverifiable') {
  console.log(`  FAIL  ${runtimeInspection.message}`)
  console.log(`  INFO  not falling back to the deprecated in-tree ${runtimeInspection.legacyDir} (that is the bug this check fixes)`)
} else {
  console.log(
    `  INFO  cargo target dir (source: ${runtimeInspection.source}): ${runtimeInspection.targetDirs.map((entry) => `${entry.label}=${entry.dir}`).join(', ')}`,
  )
  if (runtimeInspection.legacyPresent) {
    console.log(`  INFO  ignoring the deprecated in-tree runtime target (${runtimeInspection.legacyDir}) — real runs use the dirs above`)
  }
  if (runtimeInspection.status === 'missing') {
    console.log(`  INFO  runtime debug binary missing in ${runtimeInspection.targetDirs.map((entry) => entry.dir).join(', ')} — first \`cargo run\` will build it`)
  } else {
    // Oldest-to-newest per stack, then judge the newest one: that is the binary a
    // fresh `cargo run` in this checkout would reuse.
    for (const binary of runtimeInspection.binaries) {
      console.log(`  INFO  ${binary.label}: ${binary.path} (${fmtAge(now - binary.mtimeMs)} old)`)
    }
    const newest = runtimeInspection.newest
    if (runtimeInspection.status === 'stale') {
      console.log(`  WARN  newest runtime debug binary (${newest.label}, ${fmtAge(now - newest.mtimeMs)} old) is stale vs ${runtimeSourceNewest.path} — cargo will rebuild it`)
    } else {
      console.log(`  OK    newest runtime debug binary (${newest.label}, ${fmtAge(now - newest.mtimeMs)} old) is newer than runtime sources`)
    }
  }
  for (const release of runtimeInspection.releases) {
    console.log(`  INFO  runtime release binary present in ${release.label} (${fmtAge(now - release.mtimeMs)} old) — host E2E uses the debug binary`)
  }
}
const lockHits = []
const lockDirs = [
  ...runtimeTargets.targetDirs.flatMap((target) => [join(target.dir, 'debug'), join(target.dir, 'release')]),
  cpTarget,
]
for (const dir of lockDirs) {
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

// ------------------------------------------------------------------ 4. disk
// Window admission: the host lane writes tens of GB to H, and a run that dies
// on a full disk pollutes the tree — the failure then looks like a test red.
// The sampler is injectable (scripts/lib/e2e-preflight-disk.mjs) so the
// thresholds are unit-tested with fake samples, never by filling a real disk.
// Kept as a function so `--disk-only` can run exactly this section and exit with
// `diskExitCode`, printing the same machine-readable line as the full run.
function runDiskGate() {
  console.log('[4/5] disk headroom (window admission)')
  const result = evaluateDisks({
    sampler: () => sampleDisksViaPsDrive({ runCapture }),
    platform: process.platform,
  })
  // Machine-readable line for the next workflow (do not parse the prose below).
  console.log(`  disk  ${JSON.stringify(result)}`)
  if (result.skipped) {
    console.log(`  SKIP  ${result.reasons[0]}`)
  } else if (result.unverifiable) {
    console.log(`  FAIL  disk headroom UNVERIFIABLE — ${result.reasons[0]}`)
  } else {
    const describe = (drive) => `${drive.pctFree}% free (${drive.freeGB}/${drive.totalGB} GB)`
    console.log(`  INFO  H ${describe(result.detail.H)}, C ${describe(result.detail.C)}`)
  }
  for (const finding of result.findings) {
    add(finding.severity, 'disk', finding.message, finding.hint)
    console.log(`  ${finding.severity}  ${finding.message}`)
    if (finding.hint) console.log(`        hint: ${finding.hint}`)
  }
  if (result.ok && !result.skipped && result.findings.length === 0) {
    console.log(`  OK    both drives above the blocking thresholds (H ${DISK_THRESHOLDS.hBlocksBelowPct}% / C ${DISK_THRESHOLDS.cBlocksBelowPct}%; H under ${DISK_THRESHOLDS.hWarnsBelowPct}% only warns)`)
  }
  if (diskExitCode(result) !== 0) console.log('  -> this blocks the window (preflight exit 1)')
  console.log('')
  return result
}
const diskResult = runDiskGate()

// --------------------------------------------------------------- 5. digest
console.log('[5/5] recent runs (.local/dev + Playwright last run)')
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
      if (alive && selfPids.has(rawPid)) {
        console.log(`  INFO  newest log ${newestLog.name} is this caller's own run (pid ${rawPid}); not a concurrent run`)
      } else if (alive) {
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
    // BL-413: dev ports must be part of the Get-NetTCPConnection filter too —
    // dropping them only after the JSON round-trip cannot recover a listener
    // the query never returned (e.g. the stack runtime on 12633).
    const queryRanges = [...ranges, ...dev.map(({ port }) => [port, port])]
    // Leading commas keep each range a nested array: @(,@(a,b)) is a one-element
    // array holding @(a,b), whereas @(@(a,b)) flattens to a two-int array and
    // makes `$_[0]`/`$_[1]` null (silently reporting zero listeners).
    const rangeLiteral = queryRanges.map(([a, b]) => `,@(${a},${b})`).join('')
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
      return list
        .filter((item) => item && wanted.has(Number(item.port)) && !OS_EXCLUDED_PORTS.has(Number(item.port)))
        .map((item) => ({
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
    if (wanted.has(port) && !OS_EXCLUDED_PORTS.has(port)) hits.push({ port, address: '', pid: match[2] ?? '?', process: '' })
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
