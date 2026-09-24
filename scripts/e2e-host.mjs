import { join, dirname, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { stat as stat2, readdir, writeFile, readFile, mkdir } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { createServer as createTcpServer } from 'node:net'

const projectDir = dirname(import.meta.dirname)
const uiDir = join(projectDir, 'packages', 'ui')
const e2eRunId = `host-${Date.now()}-${randomBytes(2).toString('hex')}`
// 外部复用（XIHE_E2E_EXTERNAL_SERVER=1）时栈属于更早的 runId，而隔离 DB 名与 host root
// 都由 runId 派生：传给 Playwright 的必须是**栈的** runId，否则会去查不存在的库/目录（假失败）。
// 审计发现（PLAN-0337 Audit 2 B2）：reuse 分支此前只回写 ports，未回写 runId。
let runIdForTests = e2eRunId
const isKeep = process.argv.includes('--keep')
// PLAN-294 M4-a: persistent stack for regression matrices — boot the whole
// isolated stack once, then run Playwright repeatedly against it.
const isPersistent = process.argv.includes('--persistent')
const isTeardown = process.argv.includes('--teardown')
const stateFile = join(projectDir, '.tmp', 'e2e-host', 'persistent-stack.json')
const externalServer = process.env.XIHE_E2E_EXTERNAL_SERVER === '1'

// PLAN-0375 (BL-40) runner flags. Everything the runner consumes itself must be
// kept out of the Playwright passthrough (see runPlaywright), otherwise the
// test CLI would reject the unknown option.
const showHelp = process.argv.includes('--help') || process.argv.includes('-h')
const listBatches = process.argv.includes('--list-batches')
const skipPreflight = process.argv.includes('--skip-preflight')
const validateAtEnd = process.argv.includes('--validate-at-end')
const jarModeArg = process.argv.find((arg) => arg.startsWith('--jar-mode='))
const jarMode = jarModeArg?.slice('--jar-mode='.length) ?? 'auto'
const batchArg = process.argv.find((arg) => arg.startsWith('--batch='))
const batchName = batchArg?.slice('--batch='.length) ?? ''
const reportNameArg = process.argv.find((arg) => arg.startsWith('--report-name='))
const reportName = reportNameArg?.slice('--report-name='.length) ?? ''
if (!['auto', 'use', 'rebuild', 'run'].includes(jarMode)) {
  console.error(`[e2e-host] invalid --jar-mode=${jarMode}; expected auto | use | rebuild | run`)
  process.exit(2)
}
const e2eBatchesFile = join(projectDir, 'scripts', 'e2e-batches.jsonc')

// PLAN-0375 (R4): batch manifest. A batch pins one llm-mode and a spec list, so
// `--batch=<name>` replaces hand-listing specs for a lane/mode combination.
function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLineComment) {
      if (ch === '\n') { inLineComment = false; out += ch }
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 1 }
      continue
    }
    if (inString) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1 } else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && next === '/') { inLineComment = true; i += 1; continue }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 1; continue }
    out += ch
  }
  return out
}
function loadE2eBatches() {
  if (!existsSync(e2eBatchesFile)) throw new Error(`batch manifest not found: ${e2eBatchesFile}`)
  const parsed = JSON.parse(stripJsonComments(readFileSync(e2eBatchesFile, 'utf8')))
  if (!parsed || typeof parsed.batches !== 'object' || parsed.batches === null) {
    throw new Error(`batch manifest has no "batches" object: ${e2eBatchesFile}`)
  }
  return parsed.batches
}
let batch = null
if (batchName) {
  let batches
  try {
    batches = loadE2eBatches()
  } catch (error) {
    console.error(`[e2e-host] ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  batch = batches[batchName]
  if (!batch) {
    console.error(`[e2e-host] unknown --batch=${batchName}; available: ${Object.keys(batches).join(', ')}`)
    process.exit(2)
  }
  if (!Array.isArray(batch.specs) || batch.specs.length === 0) {
    console.error(`[e2e-host] batch ${batchName} has no specs`)
    process.exit(2)
  }
}

const workerCount = process.env.XIHE_E2E_WORKERS ?? '1'
const readinessTimeoutMs = Number(process.env.XIHE_E2E_READY_TIMEOUT_MS ?? '180000')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const uvCommand = process.platform === 'win32' ? 'uv.exe' : 'uv'
const nodeCommand = process.execPath
const mvnCommand = process.platform === 'win32' ? 'mvn.cmd' : 'mvn'
const miseCommand = process.platform === 'win32' ? 'mise.exe' : 'mise'

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
const llmMode = process.env.XIHE_E2E_LLM_MODE ?? llmModeArg?.slice('--llm-mode='.length) ?? batch?.llmMode ?? 'mock'
const batchSpecs = batch?.specs ?? []
const skipRuntime = process.argv.includes('--skip-runtime')
// Supplementary real-provider sampling (PLAN-247, requires explicit user
// approval per run). The key travels only via this env var into the CP Admin
// API import below; it is never logged, never written to fixtures, and never
// committed. When set, the Fake LLM fixture is skipped and llmMode is used
// only for spec selection.
const realXiaomiKey = process.env.XIHE_E2E_REAL_XIAOMI_KEY ?? ''
// PLAN-0372 (BL-28) decisions #A/#B: the real lane has two isolated route
// fixtures. `native` (default) keeps the historical native Xiaomi slug — tool
// calls are rejected by design, which boundary case A asserts explicitly;
// `openai-compat` points the OpenAI-compatible route at the same MiMo
// endpoint/key, where tools work and case B runs a real tool round-trip. The
// mode is per-invocation; only the two real-lane cases read it and no other
// spec is affected.
const realRoute = process.env.XIHE_E2E_REAL_ROUTE ?? 'native'
const realOpenAiBase = process.env.XIHE_E2E_REAL_OPENAI_BASE ?? 'https://api.xiaomimimo.com/v1'
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

function fmtAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 120) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

// PLAN-0375 (R2): same source-vs-artifact comparison as e2e-preflight.mjs, but
// in the runner so it can *repair* the one condition it owns (a stale CP jar)
// before the read-only preflight would otherwise block on it.
function newestMtimeSync(root, skipDirs = ['node_modules', 'target', '.git']) {
  let newest = { path: root, mtimeMs: 0 }
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
          // unreadable entry: freshness stays conservative
        }
      }
    }
  }
  return newest
}

function resolveCpJarState() {
  const cpDir = join(projectDir, 'packages', 'control-plane')
  const targetDir = join(cpDir, 'target')
  let jar = null
  if (existsSync(targetDir)) {
    for (const name of readdirSync(targetDir)) {
      if (!/^control-plane-.*\.jar$/.test(name)) continue
      const path = join(targetDir, name)
      const stat = statSync(path)
      if (!jar || stat.mtimeMs > jar.mtimeMs) jar = { path, name, mtimeMs: stat.mtimeMs }
    }
  }
  let newestSource = newestMtimeSync(join(cpDir, 'src', 'main'))
  const pomPath = join(cpDir, 'pom.xml')
  if (existsSync(pomPath)) {
    const pomStat = statSync(pomPath)
    if (pomStat.mtimeMs > newestSource.mtimeMs) newestSource = { path: pomPath, mtimeMs: pomStat.mtimeMs }
  }
  return { cpDir, jar, newestSource }
}

// R2 decision table (--jar-mode): auto = fresh jar or rebuild-then-use, falling
// back to `mvn spring-boot:run` when the rebuild cannot produce a fresh jar;
// use = always boot the existing jar; rebuild = always rebuild first; run =
// never boot a jar. A stale jar must never be used silently.
async function resolveCpBootPlan() {
  if (jarMode === 'run') return { mode: 'run', jar: null, reason: '--jar-mode=run' }
  const state = resolveCpJarState()
  if (!state.jar) return { mode: 'run', jar: null, reason: 'no CP jar in target/ (mvn spring-boot:run)' }
  const stale = state.newestSource.mtimeMs > state.jar.mtimeMs
  if (jarMode === 'use') {
    if (stale) console.warn(`[e2e-host] CP jar ${state.jar.name} is STALE but --jar-mode=use; booting it as-is`)
    return { mode: 'jar', jar: state.jar, reason: stale ? 'stale, forced by --jar-mode=use' : 'fresh (forced use)' }
  }
  if (jarMode === 'rebuild' || stale) {
    if (stale) {
      console.log(`[e2e-host] CP jar ${state.jar.name} is stale vs ${state.newestSource.path} by ${fmtAge(state.newestSource.mtimeMs - state.jar.mtimeMs)}; rebuilding (mvn -q -DskipTests package)`)
    } else {
      console.log(`[e2e-host] --jar-mode=rebuild: rebuilding CP jar (mvn -q -DskipTests package)`)
    }
    const rebuild = await run(mvnCommand, ['-q', '-DskipTests', 'package'], { cwd: state.cpDir, stdio: 'inherit' })
    if (rebuild.code !== 0) {
      console.warn(`[e2e-host] CP jar rebuild failed (exit=${rebuild.code}); falling back to mvn spring-boot:run`)
      return { mode: 'run', jar: null, reason: 'rebuild failed' }
    }
    const after = resolveCpJarState()
    if (!after.jar || after.newestSource.mtimeMs > after.jar.mtimeMs) {
      console.warn('[e2e-host] CP jar still stale after rebuild; falling back to mvn spring-boot:run')
      return { mode: 'run', jar: null, reason: 'still stale after rebuild' }
    }
    console.log(`[e2e-host] CP jar rebuilt: ${after.jar.name} (${fmtAge(Date.now() - after.jar.mtimeMs)} old)`)
    return { mode: 'jar', jar: after.jar, reason: 'rebuilt' }
  }
  return { mode: 'jar', jar: state.jar, reason: `fresh (${fmtAge(Date.now() - state.jar.mtimeMs)} old)` }
}

function printRunnerHelp() {
  console.log(`XH host E2E runner (PLAN-0375)

usage: node scripts/e2e-host.mjs [runner flags] [playwright args...]

runner flags:
  --llm-mode=<mode>     spec gate mode (mock default; also real / write_file / approval / history-marker / job / job-cancel / exec_command / overflow / success)
  --batch=<name>        expand a batch from scripts/e2e-batches.jsonc; the batch llm-mode applies unless --llm-mode is explicit
  --list-batches        list batch names, modes and spec counts, then exit
  --report-name=<file>  write the Playwright JSON report to .local/dev/<file> (adds the list,json reporter unless one is given)
  --jar-mode=<mode>     CP boot artifact policy: auto (default) | use | rebuild | run
  --skip-preflight      skip the read-only preflight (not recommended)
  --validate-at-end     run "mise run validate" once after the specs (batch closure; default off)
  --skip-runtime        boot without the Runtime service (chat-only paths)
  --persistent          boot the isolated stack, record it and exit (see reuse)
  --teardown            stop the persistent stack recorded by --persistent, then exit
  --keep                keep isolated resources for debugging
  --help, -h            this text

stack reuse (iteration; boot once, run many):
  1) node scripts/e2e-host.mjs --persistent --llm-mode=mock
  2) XIHE_E2E_EXTERNAL_SERVER=1 node scripts/e2e-host.mjs --llm-mode=<mode> [--batch=<name>] [specs...]
  3) node scripts/e2e-host.mjs --teardown

playwright args (spec files, --grep, --retries, --reporter, ...) pass through.`)
}

function printBatchList() {
  let batches
  try {
    batches = loadE2eBatches()
  } catch (error) {
    console.error(`[e2e-host] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }
  console.log(`XH host E2E batches (${e2eBatchesFile}):`)
  for (const [name, entry] of Object.entries(batches)) {
    const mode = entry.llmMode ?? '(runner default)'
    const specs = Array.isArray(entry.specs) ? entry.specs : []
    console.log(`  ${name.padEnd(16)} mode=${mode.padEnd(14)} specs=${specs.length}${entry.description ? `  ${entry.description}` : ''}`)
  }
}

// PLAN-0375 (R3): per-run artifact fingerprints. The run root is recycled on a
// successful teardown, so the fingerprints are also printed to the log (which
// lives in .local/dev) and to <runRoot>/logs/artifacts.json for evidence.
async function fingerprintArtifact(name, path, used) {
  const stat = await stat2(path)
  const buffer = await readFile(path)
  return {
    name,
    used,
    path: path.replaceAll('\\', '/').replace(`${projectDir.replaceAll('\\', '/')}/`, ''),
    sizeBytes: stat.size,
    mtime: new Date(stat.mtimeMs).toISOString(),
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

async function writeArtifactsManifest(cpBootPlan) {
  if (externalServer && !existsSync(stateFile)) {
    console.log('[e2e-host] artifact fingerprints skipped (external server without a persistent state file)')
    return
  }
  const artifacts = []
  if (cpBootPlan?.mode === 'jar' && cpBootPlan.jar && existsSync(cpBootPlan.jar.path)) {
    artifacts.push(await fingerprintArtifact('control-plane-jar', cpBootPlan.jar.path, true))
  }
  const runtimeBinary = join(projectDir, 'packages', 'runtime', 'target', 'debug', process.platform === 'win32' ? 'xihe-runtime.exe' : 'xihe-runtime')
  if (existsSync(runtimeBinary)) {
    artifacts.push(await fingerprintArtifact('runtime-debug-binary', runtimeBinary, !skipRuntime))
  }
  let gitHead = ''
  try {
    const head = await runCapture('git', ['rev-parse', 'HEAD'], { cwd: projectDir })
    if (head.code === 0) gitHead = head.stdout.trim()
  } catch {
    // not a git checkout: the field stays empty
  }
  const manifest = {
    runId: runIdForTests,
    generatedAt: new Date().toISOString(),
    llmMode,
    realRoute,
    jarMode,
    cpBoot: cpBootPlan ? { mode: cpBootPlan.mode, reason: cpBootPlan.reason } : { mode: 'external-server', reason: 'stack reuse' },
    gitHead,
    artifacts,
  }
  const logsDir = join(hostRootParent, runIdForTests, 'logs')
  try {
    await mkdir(logsDir, { recursive: true })
    const manifestPath = join(logsDir, 'artifacts.json')
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    console.log(`[e2e-host] artifact fingerprints → ${manifestPath}`)
  } catch (error) {
    console.warn(`[e2e-host] artifact manifest write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const artifact of artifacts) {
    console.log(`[e2e-host] artifact ${artifact.name}: sha256=${artifact.sha256.slice(0, 12)}… size=${artifact.sizeBytes} mtime=${artifact.mtime} used=${artifact.used}`)
  }
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

// PLAN-0369: specs may restart stack processes themselves (journey-b restarts
// Runtime; `ensureAgentWorkspaceBinding` restarts Agent). Those detached
// processes have no runner handle, so reap leftover listeners on the run's own
// (uniquely reserved) ports before teardown reverse assertions and before the
// host root is recycled (their log handles live under it).
async function listLeftoverListeners(ports) {
  if (process.platform !== 'win32') {
    const found = []
    for (const port of ports) {
      const listing = await runCapture('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']).catch(() => null)
      if (listing && listing.code === 0) {
        for (const pid of listing.stdout.split(/\s+/).filter(Boolean)) {
          found.push({ port, pid: Number(pid) })
        }
      }
    }
    return found
  }
  const listing = await runCapture('netstat.exe', ['-ano', '-p', 'tcp'])
  if (listing.code !== 0) return []
  const found = []
  for (const line of listing.stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
    if (!match) continue
    const port = Number(match[1])
    const pid = Number(match[2])
    if (ports.includes(port) && pid !== process.pid) found.push({ port, pid })
  }
  return found
}

async function killPortListeners(ports) {
  const targets = [...new Set(ports.map(Number).filter((port) => Number.isInteger(port) && port > 0))]
  if (targets.length === 0) return
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = await listLeftoverListeners(targets)
    if (found.length === 0) return
    for (const { port, pid } of found) {
      if (process.platform === 'win32') {
        await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        await run('kill', ['-TERM', String(pid)], { stdio: 'ignore' })
      }
      console.log(`[e2e-host] killed leftover listener on port ${port} (pid=${pid})`)
    }
    // Give the OS a moment to release file handles (host root recycle follows).
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  console.warn(`[e2e-host] leftover listeners still answering on ports: ${targets.join(', ')}`)
}

async function dockerCompose(args, options = {}) {
  // Windows Docker Desktop may ship compose v1 as docker-compose.exe without
  // the `docker compose` plugin — prefer the standalone binary then.
  const probe = await run('docker', ['compose', 'version'], { stdio: ['ignore', 'pipe', 'ignore'] })
  const usePlugin = probe.code === 0
  const cmd = usePlugin ? dockerCommand : 'docker-compose.exe'
  const composeArgs = usePlugin
    ? ['compose', '-p', pgProjectName, '-f', join(projectDir, 'docker-compose.yml'), ...args]
    : ['-p', pgProjectName, '-f', join(projectDir, 'docker-compose.yml'), ...args]
  return run(cmd, composeArgs, options)
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
    // PLAN-0372 decision #A: the default native route (tools rejected by
    // design). PLAN-0372 decision #B: `openai-compat` reuses the same MiMo
    // endpoint/key through the OpenAI-compatible provider (tools work).
    const llmProvider = realRoute === 'openai-compat'
      ? {
          defaultProvider: 'openai',
          openaiModel: 'mimo-v2.5',
          openaiApiBase: realOpenAiBase,
          defaultModel: 'mimo-v2.5',
        }
      : {
          defaultProvider: 'xiaomi',
          xiaomiModel: 'mimo-v2.5',
          defaultModel: 'mimo-v2.5',
        }
    const imported = await fetch(`${cpBaseUrl}/api/v1/config/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${loginBody.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 'llm-provider': llmProvider }),
    })
    if (!imported.ok) {
      const problem = await imported.text()
      throw new Error(`real provider config import failed: HTTP ${imported.status} ${problem.slice(0, 500)}`)
    }
    console.log(`[e2e-host] real provider configuration imported route=${realRoute} (key stays in the Agent env only)`)
    return
  }
  const fakeBase = `http://127.0.0.1:${fakeLlmPort}`
  // PLAN-0307 decision #21/#37 (BYOK): config layers never hold `*ApiKey` and
  // `user-preference.defaultModel` moved to `llm-provider`. Instance entries
  // carry non-secret provider/model/base only; fake credentials reach the Agent
  // through the env fallback (dev/offline path). `mock`/`missing` intentionally
  // leave the domain empty so the Agent resolves provider=mock via
  // `XIHE_LLM_PROVIDER` or fails the per-run credential gate.
  const config = llmMode === 'missing' || llmMode === 'mock'
    ? {}
    : {
        'llm-provider': {
          defaultProvider: 'openai',
          openaiModel: 'fake-openai',
          openaiApiBase: `${fakeBase}/openai/v1`,
          deepseekModel: 'fake-deepseek',
          deepseekApiBase: `${fakeBase}/deepseek/v1`,
          defaultModel: 'fake-openai',
        },
      }
  if (Object.keys(config).length === 0) {
    console.log(`[e2e-host] llm-provider config skipped mode=${llmMode} (no DB keys; env fallback only)`)
    return
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

async function removeRunSandboxContainers(runId = e2eRunId) {
  const listed = await runCapture(dockerCommand, [
    'ps', '-aq', '--filter', `label=xihe.e2e.run-id=${runId}`,
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
  // PLAN-0375: runner-owned flags must never reach the Playwright CLI.
  const runnerOnlyArgs = new Set(['--keep', '--skip-runtime', '--persistent', '--teardown', '--skip-preflight', '--validate-at-end', '--list-batches', '--help', '-h'])
  const runnerOnlyPrefixes = ['--llm-mode=', '--batch=', '--report-name=', '--jar-mode=']
  const testArgs = process.argv.slice(2).filter(
    (arg) => !runnerOnlyArgs.has(arg) && !runnerOnlyPrefixes.some((prefix) => arg.startsWith(prefix)),
  )
  let playwrightTestArgs = [...batchSpecs, ...testArgs]
  if (playwrightTestArgs.length === 0) playwrightTestArgs = ['e2e/real']
  // PLAN-0375 (R7): --report-name pins the JSON report under .local/dev
  // without depending on a hand-exported PLAYWRIGHT_JSON_OUTPUT_NAME.
  const reportPath = reportName
    ? (isAbsolute(reportName) ? reportName : join(projectDir, '.local', 'dev', reportName))
    : ''
  const hasReporter = playwrightTestArgs.some((arg) => arg === '--reporter' || arg.startsWith('--reporter='))
  if (reportPath && !hasReporter) playwrightTestArgs = ['--reporter=list,json', ...playwrightTestArgs]
  if (reportPath) console.log(`[e2e-host] JSON report → ${reportPath}`)
  // PLAN-0369: the Agent binds one MCP workspace per process. Specs that move
  // between workspaces restart the Agent through `ensureAgentWorkspaceBinding`
  // and need the exact provider/credential env the Agent was launched with.
  // PLAN-0372 (BL-28) decisions #A/#B: the real-provider lane restarts through
  // the same contract so a full real run can rebind across spec-local
  // workspaces; the contract follows the selected real route fixture (`native`
  // -> XIHE_XIAOMI_API_KEY, `openai-compat` -> XIHE_OPENAI_API_KEY). The key
  // value is the same one the runner already passes down the process tree (env
  // inheritance); it stays in memory only and is never logged.
  const agentRestartEnv = realXiaomiKey
    ? realRoute === 'openai-compat'
      ? {
          XIHE_LLM_PROVIDER: 'openai',
          XIHE_OPENAI_API_KEY: realXiaomiKey,
        }
      : {
          XIHE_LLM_PROVIDER: 'xiaomi',
          XIHE_XIAOMI_API_KEY: realXiaomiKey,
        }
    : {
        XIHE_LLM_PROVIDER: llmMode === 'mock' ? 'mock' : 'openai',
        ...(llmMode === 'missing' || llmMode === 'mock'
          ? {}
          : {
              XIHE_OPENAI_API_KEY: llmMode === 'invalid' ? 'sk-fake-invalid-key' : 'sk-fake-openai-key',
              XIHE_DEEPSEEK_API_KEY: 'fake-deepseek-key',
            }),
      }
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
      XIHE_E2E_RUN_ID: runIdForTests,
      XIHE_CP_API_TOKEN: serviceToken,
      XIHE_UI_PORT: uiPort,
      XIHE_CP_PORT: cpPort,
      XIHE_AGENT_PORT: agentPort,
      XIHE_RUNTIME_PORT: runtimePort,
      XIHE_FAKE_OAUTH_PORT: fakeOAuthPort,
      XIHE_FAKE_MCP_PORT: fakeMcpPort,
      XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
      // Test-only fixture metadata. The password remains inside the isolated
      // Postgres container; host specs seed narrowly scoped grants via docker exec.
      XIHE_E2E_PG_CONTAINER: `${pgProjectName}-postgres-1`,
      XIHE_E2E_PG_DATABASE: pgDatabase,
      XIHE_E2E_PG_USER: pgUser,
      XIHE_E2E_PG_PORT: pgPort,
      XIHE_E2E_LLM_MODE: llmMode,
      XIHE_E2E_ADMIN_PASSWORD: e2eAdminPassword,
      XIHE_E2E_AGENT_RESTART_ENV: JSON.stringify(agentRestartEnv),
      // PLAN-0372 decisions #A/#B: the real-lane cases read the selected route
      // fixture (no secrets; mock lane ignores it).
      XIHE_E2E_REAL_ROUTE: realRoute,
      XIHE_E2E_HEADED: process.env.XIHE_E2E_HEADED ?? '0',
      XIHE_E2E_BROWSER_CHANNEL: process.env.XIHE_E2E_BROWSER_CHANNEL ?? 'chrome-beta',
      ...(reportPath ? { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath } : {}),
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
    // PLAN-0369: reap spec-restarted detached processes (Runtime/Agent) first —
    // they are outside `dockerProcesses`, their log handles live under the host
    // root being recycled, and ports are run-unique.
    await killPortListeners([uiPort, cpPort, agentPort, runtimePort])

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
  // PLAN-0375 (R5): reuse rounds skip per-run container cleanup, so the stack's
  // Sandbox containers are reclaimed here by the stack run id (otherwise the
  // next window's preflight reports them as residue).
  try {
    const removed = await removeRunSandboxContainers(state.runId)
    console.log(`[e2e-host] removed ${removed} Sandbox containers for persistent stack ${state.runId}`)
  } catch (error) {
    console.warn(`[e2e-host] persistent Sandbox cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (process.platform === 'win32') {
    const probe = await run('docker', ['compose', 'version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const usePlugin = probe.code === 0
    const cmd = usePlugin ? 'docker' : 'docker-compose.exe'
    const args = usePlugin
      ? ['compose', '-p', state.pgProjectName, '-f', join(projectDir, 'docker-compose.yml'), 'down', '--volumes', '--remove-orphans']
      : ['-p', state.pgProjectName, '-f', join(projectDir, 'docker-compose.yml'), 'down', '--volumes', '--remove-orphans']
    await run(cmd, args, { stdio: 'inherit' })
  }
  // PLAN-0369: spec-restarted Runtime/Agent processes are detached; port 扫尾
  // keeps `--teardown` from leaking them.
  await killPortListeners([state.ports?.ui, state.ports?.cp, state.ports?.agent, state.ports?.runtime])
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

// PLAN-0375 (R1): read-only preflight gate. Returns false when the run must
// not start. `allowPorts`/`ownRunId` mark the caller's own persistent stack in
// reuse mode; `--self-pid` marks this process's own detached log/pid record.
async function runPreflightGate({ allowPorts = [], ownRunId = '', extraSelfPids = [] } = {}) {
  if (skipPreflight) {
    console.log('[e2e-host] --skip-preflight set; skipping the read-only preflight')
    return true
  }
  console.log('[e2e-host] preflight (read-only): node scripts/e2e-preflight.mjs')
  const selfPids = [process.pid, ...extraSelfPids.filter((pid) => Number.isInteger(pid) && pid > 0)]
  const preflightArgs = [join(projectDir, 'scripts', 'e2e-preflight.mjs'), `--self-pid=${selfPids.join(',')}`]
  if (jarMode === 'run') preflightArgs.push('--ignore-build')
  if (allowPorts.length > 0) preflightArgs.push(`--allow-ports=${allowPorts.join(',')}`)
  if (ownRunId) preflightArgs.push(`--own-run-id=${ownRunId}`)
  const preflight = await runCapture(nodeCommand, preflightArgs)
  if (preflight.stdout) process.stdout.write(preflight.stdout)
  if (preflight.stderr) process.stderr.write(preflight.stderr)
  if (preflight.code !== 0) {
    console.error('[e2e-host] preflight reported blocking findings; not starting a run.')
    console.error('[e2e-host] handle the findings above (teardown residue / ports / active run), then retry.')
    console.error('[e2e-host] --skip-preflight bypasses this gate (use only when you know the finding is not yours).')
    return false
  }
  return true
}

async function main() {
  if (showHelp) {
    printRunnerHelp()
    return
  }
  if (listBatches) {
    printBatchList()
    return
  }
  if (isTeardown) {
    await teardownPersistent()
    return
  }
  // PLAN-0375 (R2): repair the artifact condition the runner owns *before* the
  // read-only preflight runs — preflight fails on a stale CP jar, so a
  // preflight-first order would make the rebuild unreachable.
  let cpBootPlan = null
  if (!externalServer) {
    cpBootPlan = await resolveCpBootPlan()
    console.log(`[e2e-host] CP boot: ${cpBootPlan.mode === 'jar' ? `java -jar ${cpBootPlan.jar.name}` : 'mvn spring-boot:run'} (${cpBootPlan.reason})`)
  }
  console.log(`[e2e-host] runId=${e2eRunId} ports ui=${uiPort} cp=${cpPort} agent=${agentPort} runtime=${runtimePort} pg=${pgPort}`)
  console.log(`[e2e-host] isolated pg project=${pgProjectName} db=${pgDatabase} hostRoot=${hostRoot}`)
  if (skipRuntime) console.log('[e2e-host] --skip-runtime set; this run validates chat-only paths without Sandbox execution')
  await precheckDevRuntimeConflict()
  await pruneStaleRunDirs()

  // Reuse mode: a persistent stack is already up — point this run's ports at
  // it and skip every boot phase.
  let reuseOwnPorts = []
  let reuseOwnRunId = ''
  let reuseRunnerPid = 0
  if (externalServer && existsSync(stateFile)) {
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    reuseRunnerPid = Number(state.runnerPid) || 0
    uiPort = state.ports.ui; cpPort = state.ports.cp; agentPort = state.ports.agent
    runtimePort = state.ports.runtime; pgPort = state.ports.pg
    // PLAN-0365 (root cause A): restore fixture ports the same way — without
    // this the reserved random values point at nothing and fixture-backed
    // specs (fake OAuth/MCP/LLM) fail with ERR_CONNECTION_REFUSED.
    if (state.ports.fakeOAuth) fakeOAuthPort = state.ports.fakeOAuth
    if (state.ports.fakeMcp) fakeMcpPort = state.ports.fakeMcp
    if (state.ports.fakeLlm) fakeLlmPort = state.ports.fakeLlm
    runIdForTests = state.runId
    reuseOwnPorts = [uiPort, cpPort, agentPort, runtimePort, pgPort, fakeOAuthPort, fakeMcpPort, fakeLlmPort]
    reuseOwnRunId = state.runId
    console.log(`[e2e-host] persistent stack ${state.runId}: ui=${uiPort} cp=${cpPort} agent=${agentPort} runtime=${runtimePort}`)
    // 关键：本进程新生成的 e2eRunId 与栈不同，传给 Playwright 的必须是栈 runId
    // （隔离库名与 host root 都由它派生）。两者都打印，避免操作者误判。
    console.log(`[e2e-host] reuse: 传给 Playwright 的 XIHE_E2E_RUN_ID=${runIdForTests}（本次进程 runId=${e2eRunId} 仅用于日志）`)
  } else if (externalServer) {
    console.log('[e2e-host] XIHE_E2E_EXTERNAL_SERVER=1 set; assuming services are already running externally')
  }

  // PLAN-0375 (R1): open the window with the read-only preflight. It runs after
  // the reuse restore so the caller's own persistent stack (ports + sandbox
  // labels) is recognised instead of being reported as leaked residue.
  if (!(await runPreflightGate({ allowPorts: reuseOwnPorts, ownRunId: reuseOwnRunId, extraSelfPids: [reuseRunnerPid] }))) {
    process.exitCode = 1
    return
  }

  if (externalServer) {
    // reuse path: the persistent stack is already up, skip all boot phases.
    // PLAN-0365 (root cause E): the LLM provider is imported at boot time from
    // --llm-mode, and the fake-llm fixture only boots in non-mock modes. A
    // persistent stack booted in mock mode therefore has neither the provider
    // config nor the fixture process; restore both here so external spec runs
    // can use a different mode than the boot run.
    if (llmMode !== 'mock' && !process.env.XIHE_E2E_SKIP_FIXTURES) {
      const existing = await fetch(`http://127.0.0.1:${fakeLlmPort}/openai/v1/models`, {
        signal: AbortSignal.timeout(500),
      }).then((r) => r.ok).catch(() => false)
      if (!existing) await startFixtures()
      await configureFakeLlm()
    }
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
      XIHE_MCP_SESSION_ID_HMAC_SECRET: randomBytes(32).toString('base64url'),
       XIHE_AGENT_URL: `http://127.0.0.1:${agentPort}/internal/v1/agent/chat`,
       XIHE_AGENT_BASE_URL: `http://127.0.0.1:${agentPort}`,
       XIHE_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
       XIHE_DEV_ADMIN_PASSWORD: e2eAdminPassword,
     }
    const useCpJar = cpBootPlan?.mode === 'jar'
    const cpJar = useCpJar ? cpBootPlan.jar.path : null
    if (useCpJar) console.log(`[e2e-host] CP boot via fat jar ${cpBootPlan.jar.name} (${cpBootPlan.reason})`)
    else console.log(`[e2e-host] CP boot via mvn spring-boot:run (${cpBootPlan?.reason ?? 'external decision'})`)

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
            args: ['-q', '-DskipTests', '-Dspring-boot.run.profiles=e2e', 'spring-boot:run'],
            cwd: join(projectDir, 'packages', 'control-plane'),
            extraEnv: { ...commonCpEnv, XIHE_CP_PORT: cpPort, XIHE_LOG_DIR: e2eLogDir },
            healthUrl: `http://127.0.0.1:${cpPort}/actuator/health`,
          })
          if (llmMode !== 'mock') await configureFakeLlm()
        } else {
          const child = spawnCommand('java', ['-jar', cpJar, '--spring.profiles.active=e2e'], {
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
            XIHE_LLM_PROVIDER: realXiaomiKey
              ? realRoute === 'openai-compat'
                ? 'openai'
                : 'xiaomi'
              : llmMode === 'mock'
                ? 'mock'
                : 'openai',
            // PLAN-0307 decision #21/#37 (BYOK): fake/real credentials travel
            // through the Agent env fallback, never through config layers.
            ...(realXiaomiKey
              ? realRoute === 'openai-compat'
                ? { XIHE_OPENAI_API_KEY: realXiaomiKey }
                : { XIHE_XIAOMI_API_KEY: realXiaomiKey }
              : llmMode === 'missing' || llmMode === 'mock'
                ? {}
                : {
                    XIHE_OPENAI_API_KEY: llmMode === 'invalid' ? 'sk-fake-invalid-key' : 'sk-fake-openai-key',
                    XIHE_DEEPSEEK_API_KEY: 'fake-deepseek-key',
                  }),
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
      // PLAN-0375 (R5): the stack supervisor's pid; reuse runs hand it to the
      // preflight so the stack's continuously-written log is not mistaken for
      // a concurrent run (see runPreflightGate).
      runnerPid: process.pid,
      // PLAN-0365 (root cause A): fixture ports must round-trip too — external
      // spec runs inject them into Playwright, and a stale random port yields
      // ERR_CONNECTION_REFUSED in the OAuth/MCP fixture flows.
      ports: { ui: uiPort, cp: cpPort, agent: agentPort, runtime: runtimePort, pg: pgPort, fakeOAuth: fakeOAuthPort, fakeMcp: fakeMcpPort, fakeLlm: fakeLlmPort },
      pgProjectName,
      pids,
      // The service token is otherwise unknowable to the operator; checkpoint-budget.mjs
      // (documented --token=<XIHE_CP_API_TOKEN>) reads it from here against a persistent stack.
      serviceToken,
    }, null, 2))
    console.log(`[e2e-host] persistent stack ready; state written to ${stateFile}`)
    console.log('[e2e-host] run specs with: XIHE_E2E_EXTERNAL_SERVER=1 node scripts/e2e-host.mjs --llm-mode=<mode> <specs...>')
    console.log('[e2e-host] stop it with: node scripts/e2e-host.mjs --teardown')
    process.exitCode = 0
    return
  }
  await writeArtifactsManifest(cpBootPlan)
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
  // PLAN-0375 (R6): validate is a batch-closure action, not an iteration one.
  // It runs after teardown: with the isolated Runtime still up, `cargo build`
  // would hit the Windows binary lock (os error 5).
  if (validateAtEnd) {
    console.log('[e2e-host] --validate-at-end: running "mise run validate" once (batch closure)')
    const validateResult = await run(miseCommand, ['run', 'validate'], { stdio: 'inherit' })
    if (validateResult.code !== 0) {
      console.error(`[e2e-host] validate failed with exit=${validateResult.code}`)
      if (result.code === 0) result = { code: validateResult.code }
    } else {
      console.log('[e2e-host] validate passed')
    }
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
