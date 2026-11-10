import { join, dirname, isAbsolute } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { stat as stat2, readdir, writeFile, readFile, mkdir } from 'node:fs/promises'
import { rm } from 'node:fs/promises'
import { connect as connectTcp } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { waitForAgentLlmReady } from './lib/agent-readiness.mjs'
import { cpBuildRoot, resolveBuildTargetForStack } from './lib/cp-build-dir.mjs'
import { cpTargetDir, externalCpBuildCheck, gitHead, writeBuildInfo } from './lib/cp-build-info.mjs'
import { DEFAULT_REAL_API_BASE, llmEnv } from './lib/llm-env.mjs'
import { decideCpBoot } from './lib/cp-boot-plan.mjs'
import { readSidecar, sha256File, writeSidecarForJar } from './lib/cp-jar-sidecar.mjs'
import { stopPidIfOwned, E2E_PORT_MIN, E2E_PORT_MAX } from './lib/kill-guard.mjs'
import { ensureEnvFromUser } from './lib/user-env.mjs'
import { classifyChildExit } from './lib/e2e-child-exit.mjs'
import { CARGO_TARGET_ROOT_ENV } from './lib/stack-cargo-target.mjs'
import {
  AUTHORIZATION_SURFACE_TABLES,
  buildBlankDatabaseResetSql,
  buildDatabaseExistsQuery,
  buildDatabaseTablesQuery,
  buildDumpRestoreCommands,
  buildForeignKeySnapshotQuery,
  buildSeedCountQuery,
  buildTemplateResetSql,
  buildTruncateSql,
  chooseRoundResetStrategy,
  decideRetryRounds,
  keepTablesReferencedByKept,
  parseForeignKeySnapshot,
  parseSeedCounts,
  roundRunId,
  seedTablesFromCounts,
  selectTablesToTruncate,
} from './lib/e2e-rounds.mjs'
import {
  RETRY_HELP_LINES,
  decideLlmMode,
  decideRetrySemantics,
  formatCheckCliSummary,
  resolveOnlyPatterns,
  warnBatchPlusSpecs,
} from './lib/e2e-host-cli.mjs'

const projectDir = dirname(import.meta.dirname)
const uiDir = join(projectDir, 'packages', 'ui')

// task-237（坑 8 补充）：DSH 出的子进程/裸 node 环境里没有 User 级变量 ⇒ e2e 构建根会回落
// <one>/.tmp/cargo-target/e2e（H 根已被 task-205 删除 ⇒ 重新长出 1.6–2.0 GB 的 e2e 键）。
// 入口先用同源 helper 从 User 级补齐（写回 process.env），后续派生/起进程都吃这同一个值。
const cargoRootWiring = ensureEnvFromUser(CARGO_TARGET_ROOT_ENV)
if (cargoRootWiring.source === 'unset') {
  console.warn(
    `[e2e-host] WARN: ${CARGO_TARGET_ROOT_ENV} 未在 process env 或 User 级 env 中提供 ⇒ `
    + 'e2e 的 CARGO_TARGET_DIR 会回落到 <one>/.tmp/cargo-target/e2e（要落共享根请设 User 级变量或用 mise run）',
  )
}
const e2eRunId = `host-${Date.now()}-${randomBytes(2).toString('hex')}`

// PLAN-0656 R2 (build isolation): the E2E stack builds with its OWN target
// directories, so a normal `mise run test:e2e:host` no longer requires stopping the
// dev stacks. Both settings follow the R1 precedence rule — an explicitly provided
// environment value always wins:
//   C1  CARGO_TARGET_DIR  default <anchor>/.tmp/cargo-target/e2e — without this the
//       E2E `cargo run` collides with the running dev runtime over one exe
//       (BL-221 family; this was the sole reason the runner used to demand 12633 free).
//   C2  XIHE_CP_TARGET_DIR default C:/xihe-build/e2e — without it the E2E mvn build
//       overwrites the checkout target/classes a running dev CP is loading from.
import {
  formatTestCounts,
  judgeTestCounts,
  summarizePlaywrightReport,
} from './lib/e2e-test-counts.mjs'
import { cargoTargetBase } from './lib/stack-cargo-target.mjs'
// PLAN-0680 task-76: the window gate's *judgement* lives in a pure lib so the
// "which mode rejects / what does it defer" matrix is unit-tested instead of
// being re-derived at every call site (see the lib header for the two defects).
import {
  decideSkipPreflightDisk,
  describeDiskGate,
  describePreflightGate,
  diskGateRecord,
  evaluateGateFindings,
  parseBlockingScopes,
  parseDiskLine,
  preflightGatePolicy,
} from './lib/e2e-preflight-gate.mjs'
// task-86 (第五形态): the ORDER in which this runner opens a window is data, not something a
// reader has to trust. `bootPhasePlan()` is the single source and `main()` must `enter()` each
// phase — a gate-before-rebuild drift (defect ① of PLAN-0680) now throws instead of staying green.
import { BOOT_PHASE, bootPhasePlan, createBootPhaseCursor } from './lib/e2e-host-boot-phases.mjs'
if (typeof process.env.CARGO_TARGET_DIR !== 'string' || process.env.CARGO_TARGET_DIR.trim() === '') {
  process.env.CARGO_TARGET_DIR = join(cargoTargetBase(projectDir), 'e2e')
}
const e2eCpTargetDir =
  typeof process.env.XIHE_CP_TARGET_DIR === 'string' && process.env.XIHE_CP_TARGET_DIR.trim() !== ''
    ? process.env.XIHE_CP_TARGET_DIR
    : 'C:/xihe-build/e2e'
const e2eCpBuildArgs = ['-Dxihe.target.dir=' + e2eCpTargetDir]
console.log(
  `[e2e-host] PLAN-0656 R2 build isolation: CARGO_TARGET_DIR=${process.env.CARGO_TARGET_DIR}` +
    ` XIHE_CP_TARGET_DIR=${e2eCpTargetDir} (dev stacks are NOT stopped for this run)`,
)
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
// PLAN-0680 task-76 (defect 2): what the gate actually decided this run, so the
// run header can prove it later. Before this, `--skip-preflight` produced ONE
// console line and left no artifact — a run that opened a window on a 12%-free
// disk looked identical to one that passed every check.
let preflightRecord = null
const validateAtEnd = process.argv.includes('--validate-at-end')
const jarModeArg = process.argv.find((arg) => arg.startsWith('--jar-mode='))
const jarMode = jarModeArg?.slice('--jar-mode='.length) ?? 'auto'
const batchArg = process.argv.find((arg) => arg.startsWith('--batch='))
const batchName = batchArg?.slice('--batch='.length) ?? ''
// PLAN-0618: the docker workspace backend is frozen, so the docker-bound specs/cases are not collected by
// default. `--include-docker-frozen` restores them (one switch; inventory in
// plans/PLAN-0618-XH-docker-freeze-complete/evidence/m3-frozen-tests.md).
const includeDockerFrozen = process.argv.includes('--include-docker-frozen')
process.env.XIHE_E2E_INCLUDE_DOCKER_FROZEN = includeDockerFrozen ? '1' : '0'
const reportNameArg = process.argv.find((arg) => arg.startsWith('--report-name='))
const reportName = reportNameArg?.slice('--report-name='.length) ?? ''
// PLAN-0664 (BL-267) runner flags. Kept out of the Playwright passthrough exactly like the rest of
// the runner-owned surface (see runPlaywright): a leaked `--only`/`--check-cli` would be rejected
// by the Playwright CLI with a misleading "unknown option" error.
const checkCli = process.argv.includes('--check-cli')
// task-86: dry-run the boot-phase ORDER only (enters the real phases, short-circuits the heavy work):
// no rebuild, no preflight, no stack. Prints declared vs executed; exit 1 when they disagree.
const planOnly = process.argv.includes('--plan-only')
const allowLlmModeOverride = process.argv.includes('--allow-llm-mode-override')
// BL-421: a gated spec that self-skips still exits 0, so "green" could mean "ran nothing".
// `--expect-tests=N` pins how many tests must actually execute this round, and a non-zero
// skip count fails the run unless the caller says `--allow-skip` out loud.
const allowSkip = process.argv.includes('--allow-skip')
const expectTestsArg = process.argv.find((arg) => arg.startsWith('--expect-tests='))
const expectTestsRaw = expectTestsArg?.slice('--expect-tests='.length) ?? ''
const expectTests = expectTestsRaw === '' ? null : Number(expectTestsRaw)
const onlyPatterns = process.argv
  .filter((arg) => arg.startsWith('--only='))
  .map((arg) => arg.slice('--only='.length))
/**
 * task-238: exact residual names the caller deliberately keeps (e.g. a failed round's Postgres
 * volume for post-mortem). Forwarded verbatim to the preflight's audited `--allow-residual`;
 * omitted ⇒ the default "residue blocks the run" behaviour is unchanged.
 */
const allowResidualArg = process.argv.find((arg) => arg.startsWith('--allow-residual='))
const allowResidualNames = allowResidualArg
  ? allowResidualArg.slice('--allow-residual='.length).split(',').map((name) => name.trim()).filter(Boolean)
  : []
const RUNNER_ONLY_ARGS = new Set(['--keep', '--skip-runtime', '--persistent', '--teardown', '--skip-preflight',
  '--validate-at-end', '--list-batches', '--help', '-h', '--check-cli', '--plan-only', '--allow-llm-mode-override', '--allow-skip'])
const RUNNER_ONLY_PREFIXES = ['--llm-mode=', '--batch=', '--report-name=', '--jar-mode=', '--auth-lane=',
  '--registration-policy=', '--only=', '--expect-tests=', '--allow-residual=']
/** Everything the runner passes through to Playwright (spec files, --grep, --retries, --reporter, …). */
const playwrightPassthroughArgs = process.argv.slice(2).filter(
  (arg) => !RUNNER_ONLY_ARGS.has(arg) && !RUNNER_ONLY_PREFIXES.some((prefix) => arg.startsWith(prefix)),
)
/** Positional args are spec paths Playwright will run **in addition to** any expanded batch. */
const positionalSpecs = playwrightPassthroughArgs.filter((arg) => !arg.startsWith('-'))
/** Playwright's per-test retries (`--retries=<n>` or `--retries <n>`), if the caller set them. */
const retriesArgValue = (() => {
  const argv = process.argv.slice(2)
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg.startsWith('--retries=')) return arg.slice('--retries='.length)
    if (arg === '--retries') return argv[index + 1]
  }
  return undefined
})()
if (!['auto', 'use', 'rebuild', 'run', 'native'].includes(jarMode)) {
  console.error(`[e2e-host] invalid --jar-mode=${jarMode}; expected auto | use | rebuild | run | native`)
  process.exit(2)
}
if (expectTests !== null && (!Number.isInteger(expectTests) || expectTests < 0)) {
  console.error(`[e2e-host] invalid --expect-tests=${expectTestsRaw}; expected a non-negative integer`)
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
const readinessTimeoutMs = Number(process.env.XIHE_E2E_READY_TIMEOUT_MS ?? '120000')
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
// PLAN-0758 (D-787): the retired local-mode first-run lane is gone. Every stack now
// boots with the seeded dev admin, so the lane flags and their state round-trip went with it.
const registrationPolicyArg = process.argv.find((arg) => arg.startsWith('--registration-policy='))
let registrationPolicy = registrationPolicyArg
  ? registrationPolicyArg.slice('--registration-policy='.length)
  : (batch?.registrationPolicy ?? 'open')
if (registrationPolicy !== 'open' && registrationPolicy !== 'closed') {
  console.error(`[e2e-host] invalid --registration-policy=${registrationPolicy}; expected open|closed`)
  process.exit(2)
}
const requestedLlmMode = process.env.XIHE_E2E_LLM_MODE
  ?? llmModeArg?.slice('--llm-mode='.length)
  ?? batch?.llmMode
let batchSpecs = batch?.specs ?? []
// PLAN-0664 (BL-267): `--only` narrows an expanded batch. Refuse before any side effect; `--help` /
// `--list-batches` / `--teardown` stay reachable because they never boot a run.
if (onlyPatterns.length > 0 && !showHelp && !listBatches && !isTeardown) {
  const onlyResolution = resolveOnlyPatterns({ batchName, batchSpecs, onlyPatterns })
  if (onlyResolution.action === 'refuse') {
    console.error(`[e2e-host] REFUSE ${onlyResolution.message}`)
    process.exit(2)
  }
  batchSpecs = onlyResolution.specs
}
const checkpointSaverProbeRequested = process.argv.some((arg) => {
  const normalized = arg.replaceAll('\\', '/')
  return normalized === 'checkpoint-saver-probe.spec.ts'
    || normalized === 'e2e/real/checkpoint-saver-probe.spec.ts'
    || normalized.endsWith('/e2e/real/checkpoint-saver-probe.spec.ts')
}) || batchSpecs.some((spec) => {
  const normalized = spec.replaceAll('\\', '/')
  return normalized === 'e2e/real/checkpoint-saver-probe.spec.ts'
    || normalized.endsWith('/e2e/real/checkpoint-saver-probe.spec.ts')
})
const checkpointResumeRequested = process.argv.some((arg) => {
  const normalized = arg.replaceAll('\\', '/')
  return normalized === 'checkpoint-resume.spec.ts'
    || normalized === 'e2e/real/checkpoint-resume.spec.ts'
    || normalized.endsWith('/e2e/real/checkpoint-resume.spec.ts')
}) || batchSpecs.some((spec) => {
  const normalized = spec.replaceAll('\\', '/')
  return normalized === 'e2e/real/checkpoint-resume.spec.ts'
    || normalized.endsWith('/e2e/real/checkpoint-resume.spec.ts')
})
const exactCheckpointHostProbeRequested = checkpointSaverProbeRequested || checkpointResumeRequested
const llmMode = checkpointResumeRequested && requestedLlmMode === undefined
  ? 'checkpoint_resume'
  : requestedLlmMode ?? 'mock'
// PLAN-0566 (D6): auth rate-limit lane selection over the existing
// XIHE_CP_AUTH_* key surface (no product code change, no new keys). `exempt`
// (default) disables the register dimension for full-matrix lanes so journey
// registrations never trip AUTH_RATE_LIMITED; `ratelimit` lowers thresholds
// and trusts the loopback proxies so the auth-lane specs can drive and assert
// real 429 responses through a non-loopback X-Forwarded-For literal.
const authLaneArg = process.argv.find((arg) => arg.startsWith('--auth-lane='))
const authLane = authLaneArg ? authLaneArg.slice('--auth-lane='.length) : 'exempt'
if (authLane !== 'exempt' && authLane !== 'ratelimit') {
  throw new Error(`invalid --auth-lane value: ${authLane} (expected exempt|ratelimit)`)
}
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
// PLAN-0504: base URLs no longer travel through config; the real-lane specs
// read XIHE_E2E_REAL_OPENAI_BASE from the inherited env directly when they
// create the connection fixture, so the runner keeps no constant for it.
const fakeMcpAccessToken = randomPassword(24)
const fakeMcpResumeControlToken = checkpointResumeRequested ? randomPassword(32) : ''
let e2eAdminPassword = randomPassword(24)

// PLAN-0547 decision #3: e2e-host deliberately does NOT read the .env chain — its admin
// password is self-generated per run (or taken from the harness state at :1602) so E2E
// runs stay hermetic and cannot be influenced by a developer's .env.local.

// PLAN-0465: reuse 模式下按栈 runId 恢复（与 pgProjectName 同批）——DB 名由栈
// runId 派生，调用方 runId 派生的名字在持久栈上不存在。
let pgDatabase = `xihe_e2e_${e2eRunId.replace(/[^a-z0-9]/gi, '_')}`
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
// PLAN-0465: reuse 模式下必须恢复为栈的 pg project（见 reuse block）。
let pgProjectName = `xihe-e2e-host-${e2eRunId.replace(/[^a-z0-9]/gi, '')}`
let serviceToken = randomPassword(24)
const nativeNoProxy = [
  process.env.NO_PROXY,
  process.env.no_proxy,
  'localhost',
  '127.0.0.1',
  'host.docker.internal',
].filter(Boolean).join(',')

const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker'

const dockerProcesses = []
const nativeServiceConfigs = new Map()
const nativeServiceChildren = new Map()
let checkpointProbeControlServer = null
let checkpointProbeControlToken = null
let checkpointProbeControlUrl = null
// BL-538: per-run directory a spec writes its declared service-stop window into, e.g.
// `runtime.json` = { service, spec, startedAt, expiresAt }. Kept under the run dir (never the
// repo) and consumed single-use below, so a crash-restart loop cannot be forgiven twice.
let declaredExitDir = null
let agentDatabaseConfigPresent = null
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

function resolveCpJarState(targetDir = join(projectDir, 'packages', 'control-plane', 'target')) {
  const cpDir = join(projectDir, 'packages', 'control-plane')
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
  // BL-477 / task-90: identity comes from the sidecar when a producer wrote one. A jar whose bytes
  // differ from the manifest that describes it is NOT "fresh because its mtime is new": the manifest
  // only exists because some producer fingerprinted *that* artifact, so a mismatch means the jar was
  // replaced behind it (hand-run `mvn package`, a copied jar). Hashing ~78 MB costs a few hundred ms
  // and only happens when a sidecar exists; without one `identity` stays null and mtime decides.
  let sidecar = { state: 'missing', file: null, data: null, identity: null, reason: 'no sidecar manifest' }
  if (jar) {
    const read = readSidecar({ jarPath: jar.path })
    if (read.state === 'invalid') {
      sidecar = { state: 'invalid', file: read.file, data: null, identity: false, reason: `the sidecar is unusable: ${read.error}` }
    } else if (read.state === 'ok') {
      const actual = sha256File(jar.path)
      const identity = actual.ok ? actual.sha256 === read.data.jarSha256 && jar.name === read.data.jarName : null
      sidecar = {
        state: 'ok',
        file: read.file,
        data: read.data,
        identity,
        reason: identity === true
          ? `the jar matches the manifest written for ${read.data.commit.slice(0, 12)}`
          : identity === false
            ? `the manifest describes ${read.data.jarName} (sha256 ${read.data.jarSha256.slice(0, 12)}…) but the jar on disk is ${jar.name}`
            : `cannot hash the jar to check the manifest: ${actual.error}`,
      }
    } else {
      sidecar = { state: 'missing', file: read.file, data: null, identity: null, reason: 'no sidecar manifest' }
    }
  }
  return { cpDir, jar, newestSource, sidecar }
}

// R2 decision table (--jar-mode): auto = fresh jar, else build-then-use (a MISSING jar
// is built once and reused instead of falling into `mvn spring-boot:run`, which never
// produces a jar — BL-205 ②); use = always boot the existing jar; rebuild = always
// rebuild first; run = never boot a jar. A stale jar must never be used silently.
// The decision itself is `lib/cp-boot-plan.mjs` (pure, unit-tested); this function only
// performs the side effects (warn, build, re-inspect, fall back).
async function resolveCpBootPlan() {
  if (jarMode === 'native') {
    // PLAN-0656 R2: the native mode keeps its historical checkout `target/` layout
    // (native-image output does not follow -Dxihe.target.dir the same way); it is an
    // explicit opt-in mode and out of the dev-stack coexistence scope.
    const state = resolveCpJarState()
    const executableName = process.platform === 'win32' ? 'control-plane.exe' : 'control-plane'
    const executablePath = join(state.cpDir, 'target', executableName)
    if (!existsSync(executablePath)) {
      throw new Error(`--jar-mode=native requires ${executablePath}; build with mvn -Pnative,native-build native:compile`)
    }
    const executableStat = statSync(executablePath)
    if (state.newestSource.mtimeMs > executableStat.mtimeMs) {
      throw new Error(`native CP executable is stale vs ${state.newestSource.path}; rebuild before host E2E`)
    }
    return {
      mode: 'native',
      executable: { path: executablePath, name: executableName, mtimeMs: executableStat.mtimeMs },
      reason: 'forced native executable',
    }
  }
  const state = resolveCpJarState(e2eCpTargetDir)
  // task-90: an artifact that is not the one its sidecar describes cannot be trusted on mtime alone,
  // so it takes the same "build before boot" path as a stale jar (never booted silently).
  const identityMismatch = state.sidecar.state === 'ok' && state.sidecar.identity === false
  const staleByMtime = state.jar ? state.newestSource.mtimeMs > state.jar.mtimeMs : false
  const stale = state.jar ? staleByMtime || identityMismatch : false
  const plan = decideCpBoot({ jarMode, hasJar: Boolean(state.jar), stale })
  if (plan.action === 'run') return { mode: 'run', jar: null, reason: plan.reason }
  if (plan.action === 'use') {
    if (staleByMtime) console.warn(`[e2e-host] CP jar ${state.jar.name} is STALE but --jar-mode=use; booting it as-is`)
    if (identityMismatch) {
      console.warn(
        `[e2e-host] CP jar ${state.jar.name} is NOT the artifact its sidecar describes (${state.sidecar.reason});`
          + ' --jar-mode=use boots it anyway, and that mode skips the artifact section, so nothing later re-checks it',
      )
    }
    return { mode: 'jar', jar: state.jar, reason: plan.reason }
  }
  // plan.action === 'build-then-use': missing jar, stale jar, or a forced rebuild.
  if (!state.jar) {
    console.log('[e2e-host] no CP jar in the E2E build dir: building one once (mvn -q -DskipTests package) so later runs reuse it')
  } else if (identityMismatch) {
    console.log(`[e2e-host] CP jar ${state.jar.name} is not the artifact its sidecar describes (${state.sidecar.reason}); rebuilding (mvn -q -DskipTests package)`)
  } else if (staleByMtime) {
    console.log(`[e2e-host] CP jar ${state.jar.name} is stale vs ${state.newestSource.path} by ${fmtAge(state.newestSource.mtimeMs - state.jar.mtimeMs)}; rebuilding (mvn -q -DskipTests package)`)
  } else {
    console.log(`[e2e-host] --jar-mode=rebuild: rebuilding CP jar (mvn -q -DskipTests package)`)
  }
  const rebuild = await run(mvnCommand, ['-q', '-DskipTests', ...e2eCpBuildArgs, 'package'], { cwd: state.cpDir, stdio: 'inherit' })
  if (rebuild.code !== 0) {
    console.warn(`[e2e-host] CP jar rebuild failed (exit=${rebuild.code}); falling back to mvn spring-boot:run`)
    return { mode: 'run', jar: null, reason: 'rebuild failed' }
  }
  const after = resolveCpJarState(e2eCpTargetDir)
  if (!after.jar || after.newestSource.mtimeMs > after.jar.mtimeMs) {
    console.warn('[e2e-host] CP jar still stale after rebuild; falling back to mvn spring-boot:run')
    return { mode: 'run', jar: null, reason: 'still stale after rebuild' }
  }
  // The rebuild mvn goal does not write build-info, but the external-stack gate treats a
  // missing stamp as a failure. Stamp only after the successful build and the fresh-jar
  // check above, using the real HEAD/dirty state (never a hand-filled commit).
  const head = gitHead({ cwd: projectDir })
  if (!head.commit) {
    console.warn(`[e2e-host] CP jar rebuilt but git HEAD is unavailable (${head.error}); build-info not stamped`)
  } else {
    writeBuildInfo({ targetDir: e2eCpTargetDir, commit: head.commit, dirty: head.dirty })
    console.log(`[e2e-host] CP build-info stamped for ${head.commit} (dirty=${head.dirty})`)
  }
  // BL-477 / task-90: the fingerprint is written by the same code path that produced the jar and only
  // *after* packaging finished — a manifest written any earlier would describe a jar that does not
  // exist yet, and its `builtAt` would predate the artifact. It records the jar's own sha256, so a
  // later reader can prove the manifest is about *this* file (unlike the in-jar build-info stamp,
  // which the CP build reuses from an earlier generation).
  const sidecarWrite = writeSidecarForJar({ projectDir, jarPath: after.jar.path, writtenBy: 'scripts/e2e-host.mjs' })
  if (!sidecarWrite.ok) {
    console.warn(`[e2e-host] CP jar rebuilt but its sidecar was NOT written (${sidecarWrite.error}); freshness will fall back to content evidence`)
  } else {
    const fingerprint = sidecarWrite.data
    console.log(
      `[e2e-host] CP jar sidecar written: ${sidecarWrite.file} (jar sha256 ${fingerprint.jarSha256.slice(0, 12)}…,`
        + ` CP tree ${fingerprint.sourceTreeSha256.slice(0, 12)}…, commit ${fingerprint.commit.slice(0, 12)}, dirty=${fingerprint.dirty})`,
    )
    if (sidecarWrite.clockSkewMs > 0) {
      console.warn(`[e2e-host] sidecar builtAt was clamped by ${sidecarWrite.clockSkewMs} ms: the system clock is behind the jar mtime`)
    }
  }
  console.log(`[e2e-host] CP jar rebuilt: ${after.jar.name} (${fmtAge(Date.now() - after.jar.mtimeMs)} old)`)
  return { mode: 'jar', jar: after.jar, reason: 'rebuilt' }
}

// task-86: side-effect-free twin of `resolveCpBootPlan()` for `--plan-only`. Same jar-state read
// (mtime staleness + the task-90 sidecar identity check) and the same `decideCpBoot()` table, but it
// never runs `mvn` — the point of the dry run is the phase ORDER, not a build. The `reason` says so,
// so nobody can read a preview as "the jar is fresh".
function previewCpBootPlan() {
  if (jarMode === 'native') {
    return { mode: 'native', executable: { name: '(native executable; --plan-only does not build it)' }, reason: '--plan-only preview' }
  }
  const state = resolveCpJarState(e2eCpTargetDir)
  const identityMismatch = state.sidecar.state === 'ok' && state.sidecar.identity === false
  const staleByMtime = state.jar ? state.newestSource.mtimeMs > state.jar.mtimeMs : false
  const stale = state.jar ? staleByMtime || identityMismatch : false
  const plan = decideCpBoot({ jarMode, hasJar: Boolean(state.jar), stale })
  const wouldBuild = plan.action === 'build-then-use'
  return {
    mode: state.jar ? 'jar' : 'run',
    jar: state.jar,
    reason: `${plan.reason}${wouldBuild ? ' (a real run would rebuild here)' : ''}; --plan-only preview (no rebuild ran)`,
  }
}

function printRunnerHelp() {
  console.log(`XH host E2E runner (PLAN-0375)

usage: node scripts/e2e-host.mjs [runner flags] [playwright args...]

runner flags:
  --include-docker-frozen  collect the docker-frozen specs/cases too (default: skipped as "DOCKER_FROZEN")
--llm-mode=<mode>     spec gate mode (mock default; also real / write_file / approval / spawn_agent / history-marker / job / job-cancel / exec_command / overflow / reasoning / success)
  --batch=<name>        expand a batch from scripts/e2e-batches.jsonc; the batch llm-mode applies unless --llm-mode is explicit
                        (positional spec paths are ADDED to the batch, not a narrowing — use --only; a differing
                        --llm-mode/XIHE_E2E_LLM_MODE is refused unless --allow-llm-mode-override)
  --only=<path|base|fragment>  narrow an expanded --batch to one target: exact path or basename first, then a substring
                        that must match exactly one spec (ambiguous ⇒ exit 2 with candidates; needs --batch)
  --check-cli           validate runner args and print the planned batch/specs/warnings, then exit (boots nothing)
  --plan-only           dry-run the boot-phase ORDER only: enter the real phases with the heavy work short-circuited
                        (no rebuild, no preflight, no stack), print declared vs executed, exit 1 if they disagree
  --allow-llm-mode-override  let --llm-mode/XIHE_E2E_LLM_MODE differ from the batch llmMode (default: refuse to start)
  --auth-lane=<lane>    CP auth env lane (PLAN-0566 D6): exempt (default, register dimension off) | ratelimit (lowered thresholds + loopback trusted proxies for auth-lockout / auth-rate-limit)
  --registration-policy=<p>  open | closed (default open); injected as XIHE_AUTH_REGISTRATION_POLICY
  --list-batches        list batch names, modes and spec counts, then exit
  --report-name=<file>  write the Playwright JSON report to .local/dev/<file> (adds the list,json reporter unless one is given)
  --expect-tests=<n>    require exactly <n> tests to have EXECUTED this round (expected+flaky+unexpected);
                        refuses to run if you also pass your own --reporter
  --allow-skip          accept skipped tests (default: any skip fails the run — a gated spec that
                        self-skips would otherwise look like a pass)
  --jar-mode=<mode>     CP boot artifact policy: auto (default) | use | rebuild | run | native (fail-closed; enables the CP↔Runtime WebSocket channel)
  --skip-preflight      skip the preflight's docker/port/artifact/run checks, but NOT the disk
                        gate (that still runs via --disk-only) and NOT silently: the verdict is
                        recorded as preflight.diskGate in the run header (not recommended)
  --validate-at-end     run "mise run validate" once after the specs (batch closure; default off)
  --skip-runtime        boot without the Runtime service (chat-only paths)
  --persistent          boot the isolated stack, record it and exit (see reuse)
  --teardown            stop the persistent stack recorded by --persistent, then exit
  --keep                keep isolated resources for debugging
  --help, -h            this text

retry semantics (PLAN-0650 M5 + PLAN-0664; these are TWO different knobs and they stack):
${RETRY_HELP_LINES.join('\n')}
  XIHE_E2E_REBUILD_ON_RETRY=1        legacy shape: one attempt per process (a re-run rebuilds the stack)
  XIHE_E2E_ROUND_RESET=<strategy>    truncate (default) | template | dump-restore — see lib/e2e-rounds.mjs

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
  if (cpBootPlan?.mode === 'native' && cpBootPlan.executable && existsSync(cpBootPlan.executable.path)) {
    artifacts.push(await fingerprintArtifact('control-plane-native', cpBootPlan.executable.path, true))
  }
  const runtimeBinary = resolveRuntimeBinary()
  if (runtimeBinary.path) {
    const label = runtimeBinary.path.replaceAll('\\', '/').includes('/debug/')
      ? 'runtime-debug-binary'
      : 'runtime-binary'
    artifacts.push(await fingerprintArtifact(label, runtimeBinary.path, !skipRuntime))
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
    // PLAN-0680 task-76: the window gate's own verdict belongs in the run header.
    // `diskGate.mode` is `enforced` when the disk section actually ran (always, unless
    // the segment itself was unusable) and `bypassed` only when it produced no verdict —
    // so "opened on a nearly-full disk" and "skipped the disk gate" stop looking alike.
    preflight: preflightRecord,
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

function isWithin(child, parent) {
  const childPath = child.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  const parentPath = parent.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`)
}

// PLAN-0631: argv 数组语义在 cmd 拼接层会丢 —— 含 cmd 元字符（| & < > ^ ( ) % ! " 空格）的
// arg 必须加 cmd 安全引号（双引号包裹 + 内部 " 转义为 \"），否则 `|` 会被当成管道符
// （实测：合并 grep 正则里的 `|` 把 argv 切成两半，管道另一端垃圾 ⇒ EPIPE）。
// 无特殊字符的 arg 原样不动：现状行为不变，爆炸半径最小。
const CMD_SPECIAL = /[\s|&<>^()%!"]/
function cmdQuoteArg(arg) {
  if (!CMD_SPECIAL.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

function spawnCommand(program, args, options) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(program)) {
    // 只按 arg 加引号，不再整行外包：node 的 spawn 会自行处理含空格参数的引用，
    // 整行外包会与它叠加成双重引号（实测 `""node --version""` → cmd 报找不到路径）。
    const quoted = [program, ...args].map(cmdQuoteArg).join(' ')
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', quoted], options)
  }
  return spawn(program, args, options)
}

function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(program, args, {
      cwd: options.cwd ?? projectDir,
      env: { ...process.env, ...options.env },
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
      env: { ...process.env, ...options.env },
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

async function waitForRuntimeChannelHandshake(child, timeoutMs = readinessTimeoutMs) {
  const deadline = Date.now() + timeoutMs
  let transportConnected = false
  let channelActive = false
  let lastError = 'Runtime has not logged channel transport or active state yet'
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`Runtime exited before channel handshake (code=${child.exitCode})`)
    }
    if (existsSync(e2eLogDir)) {
      const names = await readdir(e2eLogDir)
      for (const name of names.filter((entry) => entry.startsWith('runtime.log'))) {
        const path = join(e2eLogDir, name)
        let contents
        try {
          contents = await readFile(path, 'utf8')
        } catch (error) {
          if (error?.code === 'ENOENT') {
            lastError = 'Runtime log rotated during probe'
            continue
          }
          throw error
        }
        transportConnected ||= contents.includes('channel_connected')
        channelActive ||= contents.includes('heartbeat: suppressed (channel active)')
        if (transportConnected && channelActive) {
          console.log(`[e2e-host] Runtime received channel welcome and selected channel heartbeat in ${name}`)
          return
        }
      }
    }
    lastError = transportConnected
      ? 'channel transport is open but welcome/channel-active state is not confirmed'
      : 'channel transport is not connected yet'
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Runtime WebSocket hello/welcome was not confirmed within ${timeoutMs}ms (${lastError})`)
}

/**
 * PLAN-0611 (Lead ruling D): turn a channel-handshake timeout into an actionable failure.
 *
 * The symptom that hid G2-e was a *silent* breaker: the runtime never received a channel URL, the CP
 * logged `event=circuitBreakerOpen service=runtime failureCount=…` forever, and the only visible
 * effect was "no assistant reply". So the thrown error carries the CP-side breaker evidence.
 */
async function channelHandshakeFailure(error) {
  const detail = error instanceof Error ? error.message : String(error)
  let breaker = 'cp.log not readable yet'
  try {
    const cpLog = await readFile(join(e2eLogDir, 'cp.log'), 'utf8')
    const opens = cpLog.split('\n').filter((line) => line.includes('circuitBreakerOpen service=runtime'))
    const last = opens[opens.length - 1] ?? ''
    const failureCount = last.match(/failureCount=(\d+)/)?.[1] ?? '?'
    breaker = opens.length === 0
      ? 'no circuitBreakerOpen service=runtime line in cp.log'
      : `circuitBreakerOpen count=${opens.length} lastFailureCount=${failureCount}`
  } catch (cause) {
    breaker = `cp.log unreadable: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  return new Error(
    `${detail} | CP runtime breaker: ${breaker} | the CP serves the channel only when `
    + 'XIHE_CHANNEL_ENABLED=true (the runner now sets it in every boot mode) and the runtime needs '
    + 'XIHE_CHANNEL_URL; if this still fails in mvn mode the mode does not establish the channel — '
    + 'boot with --jar-mode=native and record that finding',
  )
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

// task-237: **失败即退，禁止 hang**。
// 事故（两次同因）：native CP 因 PG 端口未就绪 `exited code=1` 后，父 `node e2e-host.mjs` 仍活、
// fake server 子进程继续占端口 —— 原因是失败路径要等 `cleanup()`（compose down + 逐个 stop +
// waitForChildExit），任何一步卡住就永远不退出。
// 规则：① 任一 runner-owned 子进程非零退出（非主动 teardown 期间）⇒ 先把整棵进程树收掉再 exit 1；
// ② `cleanup()` 带 deadline，超时则强制杀树并 exit，绝不等待。
const CLEANUP_TIMEOUT_MS = Number(process.env.XIHE_E2E_CLEANUP_TIMEOUT_MS ?? 30_000)
const BOOT_TIMEOUT_MS = Number(process.env.XIHE_E2E_BOOT_TIMEOUT_MS ?? 120_000)

/** 主动收尾期间不触发 fail-fast（teardown 杀进程会产生非零退出码，那是预期）。 */
let shuttingDown = false
let aborted = false
/** task-257: oot -> 	ests -> cleanup; only boot/tests exits stay fail-fast. */
let lifecyclePhase = 'boot'

async function forceKillAllChildren(reason) {
  for (const entry of dockerProcesses.slice().reverse()) {
    const child = entry?.child
    if (!child || child.exitCode !== null) continue
    console.error(`[e2e-host] force-kill ${entry.name} (pid=${child.pid}) — ${reason}`)
    try {
      if (process.platform === 'win32') {
        await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    } catch (error) {
      console.error(`[e2e-host] force-kill ${entry.name} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

async function abortRun(reason, exitCode = 1) {
  if (aborted) return
  aborted = true
  shuttingDown = true
  console.error(`[e2e-host] ABORT (fail-fast): ${reason}`)
  await forceKillAllChildren(reason)
  // compose 容器交给下一次 preflight 的残留检查/--teardown 收（这里不再等，避免二次 hang）
  console.error('[e2e-host] ABORT: exiting non-zero now (no teardown wait; residue is reported by the next preflight)')
  process.exit(exitCode)
}

/** 带 deadline 的收尾：超时即强杀 + 退出，绝不 hang。 */
async function cleanupWithDeadline(reason, exitCode) {
  shuttingDown = true
  let timer
  try {
    await Promise.race([
      cleanup(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`cleanup exceeded ${CLEANUP_TIMEOUT_MS}ms (${reason})`)),
          CLEANUP_TIMEOUT_MS,
        )
      }),
    ])
  } catch (error) {
    console.error(`[e2e-host] cleanup problem: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (timer) clearTimeout(timer)
  }
  await forceKillAllChildren(reason)
  process.exit(exitCode)
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
  // PLAN-0648 端口白名单：只允许杀 e2e 块（27000-29999）内的监听者。state 文件若被
  // 污染成 dev/stack-slot 端口（12630-34 / 12640-44 / …），这里必须拒绝而不是照杀——
  // 这是"teardown 只动 e2e 自己的"硬断言的第二道（第一道在 kill-guard 的 PID 身份门）。
  const requested = [...new Set(ports.map(Number).filter((port) => Number.isInteger(port) && port > 0))]
  const outside = requested.filter((port) => port < E2E_PORT_MIN || port > E2E_PORT_MAX)
  if (outside.length > 0) {
    console.error(
      `[e2e-host] refused to touch non-e2e port(s) ${outside.join(', ')} (allowed block: ${E2E_PORT_MIN}-${E2E_PORT_MAX})`,
    )
  }
  const targets = requested.filter((port) => port >= E2E_PORT_MIN && port <= E2E_PORT_MAX)
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
  // task-237: compose **v1**（docker-compose.exe）不支持 `up --wait`。以前把 `--wait` 照传给 v1，
  // 结果"启动成功"其实只是容器创建完就返回 —— 这正给了 CP 一个"端口还没 publish 好"的窗口。
  // v1 下去掉 `--wait`，就绪判定改由 waitForPostgresContainerHealthy() 的 docker inspect 轮询负责。
  const adapted = usePlugin ? args : args.filter((arg) => arg !== '--wait')
  if (!usePlugin && adapted.length !== args.length) {
    console.log('[e2e-host] compose v1 (docker-compose.exe): dropped unsupported `--wait`; readiness uses docker inspect instead')
  }
  const composeArgs = usePlugin
    ? ['compose', '-p', pgProjectName, '-f', join(projectDir, 'docker-compose.yml'), ...adapted]
    : ['-p', pgProjectName, '-f', join(projectDir, 'docker-compose.yml'), ...adapted]
  return run(cmd, composeArgs, options)
}

async function startIsolatedPostgres() {
  const env = {
    XIHE_PG_PORT: pgPort,
    POSTGRES_DB: pgDatabase,
    POSTGRES_USER: pgUser,
    POSTGRES_PASSWORD: pgPassword,
  }
  const startedAtMs = Date.now()
  const result = await dockerCompose(['up', '-d', '--no-deps', '--wait', '--force-recreate', 'postgres'], {
    env,
    stdio: 'inherit',
  })
  if (result.code !== 0) {
    throw new Error(`isolated PostgreSQL failed to start (exit=${result.code})`)
  }
  // task-237: `up` 返回 ≠ 这个**新**容器已经在 published 端口上服务。旧代码直接进 wire 探针，
  // 探针可能命中"上一次运行的旧容器/正在 recreate 的瞬间"，于是 CP 拿到 Connection refused。
  // 这里先按容器身份硬等：本项目的容器、running、health=healthy（若有 healthcheck）、
  // 且 StartedAt 必须晚于本次 `up` 的开始。
  await waitForPostgresContainerHealthy(startedAtMs)
}

async function migrateIsolatedSchema() {
  // The CP migration runs on boot. We just wait for it via the actuator health probe.
}

function isDatabaseConnectionEnvKey(key) {
  const databaseSegments = /^(?:PG[A-Z0-9]*|POSTGRES(?:QL)?[A-Z0-9]*|DATABASE[A-Z0-9]*|DATASOURCE[A-Z0-9]*|JDBC[A-Z0-9]*|DB[A-Z0-9]*|SQLALCHEMY[A-Z0-9]*|MYSQL[A-Z0-9]*|MARIADB[A-Z0-9]*|MONGO(?:DB)?[A-Z0-9]*|REDIS[A-Z0-9]*|ORACLE[A-Z0-9]*|MSSQL[A-Z0-9]*|SQLSERVER[A-Z0-9]*)$/i
  return key.split('_').some((segment) => databaseSegments.test(segment))
}

function withoutDatabaseConnectionEnv(source) {
  const env = {}
  for (const [key, value] of Object.entries(source)) {
    if (!isDatabaseConnectionEnvKey(key) && value !== undefined) env[key] = value
  }
  return env
}

async function launchNativeService({ name, cmd, args, cwd, extraEnv, healthUrl }) {
  console.log(`[e2e-host] launching native ${name}`)
  const inheritedEnv = name === 'agent' ? withoutDatabaseConnectionEnv(process.env) : process.env
  const serviceEnv = {
    ...inheritedEnv,
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
  }
  if (name === 'agent') {
    // Only the exact T0.5 spec receives the dedicated router flag. The same
    // pair is carried separately in agentRestartEnv for workspace rebinds.
    serviceEnv.XIHE_E2E_PROFILE = exactCheckpointHostProbeRequested ? 'host' : ''
    serviceEnv.XIHE_E2E_CHECKPOINT_PROBE = checkpointSaverProbeRequested ? '1' : '0'
    serviceEnv.XIHE_E2E_CHECKPOINT_RESUME = checkpointResumeRequested ? '1' : '0'
    agentDatabaseConfigPresent = Object.keys(serviceEnv).some(isDatabaseConnectionEnvKey)
    if (agentDatabaseConfigPresent) {
      throw new Error('Agent environment contains database connection configuration')
    }
    console.log(`[e2e-host] Agent database connection env present=${agentDatabaseConfigPresent}`)
  } else if (name === 'control-plane') {
    // Probe lineage IDs are accepted only by the runner-owned exact T0.5 lane.
    serviceEnv.XIHE_E2E_CHECKPOINT_PROBE = checkpointSaverProbeRequested ? '1' : '0'
    // PLAN-0566 D6: default lane exempts the register dimension (0 disables
    // it, LoginAttemptService early-returns); the ratelimit lane lowers the
    // register threshold, trusts the loopback proxies (XFF honored) and pins
    // the account-lockout knobs the auth-lockout spec documents.
    if (authLane === 'ratelimit') {
      serviceEnv.XIHE_CP_AUTH_LOGIN_REGISTER_MAX_ATTEMPTS = '6'
      serviceEnv.XIHE_CP_AUTH_TRUSTED_PROXIES = '127.0.0.1/32,::1/128'
      serviceEnv.XIHE_CP_AUTH_LOGIN_ACCOUNT_MAX_FAILURES = '3'
      serviceEnv.XIHE_CP_AUTH_LOGIN_ACCOUNT_LOCK_SECONDS = '6'
    } else {
      serviceEnv.XIHE_CP_AUTH_LOGIN_REGISTER_MAX_ATTEMPTS = '0'
    }
  }
  const child = spawnCommand(cmd, args, {
    cwd: cwd ?? join(projectDir, 'packages', name),
    env: serviceEnv,
    stdio: 'inherit',
    windowsHide: true,
  })
  const processEntry = { name, child }
  dockerProcesses.push(processEntry)
  nativeServiceConfigs.set(name, {
    name,
    cmd,
    args: [...args],
    cwd,
    extraEnv: { ...extraEnv },
    healthUrl,
  })
  nativeServiceChildren.set(name, child)
  child.once('exit', (code, signal) => {
    console.log(`[e2e-host] native ${name} exited code=${code ?? 'null'} signal=${signal ?? 'none'}`)
    // task-237 fail-fast for a real crash; task-257: a nonzero exit during the cleanup window is
    // expected (the runner terminates its own services) and must not turn a green suite into exit=1.
    // BL-538: a spec may declare "I am about to stop this service" beforehand; the declaration is
    // consumed here and only downgrades this phase to `declared` (logged with spec + window, never
    // silent). Signal deaths and undeclared/expired exits keep the fail path.
    const intent = takeDeclaredServiceExit(name)
    const disposition = classifyChildExit({ code, signal, shuttingDown, phase: lifecyclePhase, intent })
    if (disposition === 'fail') {
      void abortRun(`native ${name} exited code=${code} (signal=${signal ?? 'none'})`)
    } else if (disposition === 'declared') {
      console.warn(
        `[e2e-host] native ${name} exited code=${code ?? 'null'} inside a DECLARED stop window `
          + `(spec=${intent.spec} window=${new Date(intent.startedAt).toISOString()}→${new Date(intent.expiresAt).toISOString()}) `
          + '— not fatal; declaration consumed (BL-538)',
      )
    } else if (disposition === 'warn') {
      console.warn(
        `[e2e-host] native ${name} exited code=${code ?? 'null'} during ${lifecyclePhase} (expected shutdown; not fatal)`,
      )
    }
  })
  child.once('error', (error) => {
    console.error(`[e2e-host] native ${name} error: ${error.message}`)
  })
  await waitForHttp(name, healthUrl, readinessTimeoutMs, {}, child)
  return child
}

async function waitForChildExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runner-owned service did not exit in time')), timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

// PLAN-0650 M5 (T5.1/T5.2): between-round state reset without rebuilding the stack.
//
// What a retry actually needs is *fresh application state*, not a fresh container. The expensive
// parts of a rebuild (postgres container + initdb + full Flyway + CP/Agent cold starts + a CP
// artifact build) are all state-independent, so a failed round resets the data plane and replays:
//   - `truncate` (default): delete every table that was empty before the first spec ran, keep the
//     boot-time seed rows (owner account, roles, imported config). No service restart at all, which
//     is the only variant that can meet "round-2 startup <= 50% of round-1".
//   - `template`: stop CP/Agent, drop the round DB and recreate it from a schema-only template DB,
//     restart them. Slower, but immune to a table whose rows the specs must not keep.
//   - `dump-restore`: same shape with a per-round `pg_dump --schema-only` + `psql -f`.
// The SQL/argv for all three lives in `lib/e2e-rounds.mjs` (pure, unit-tested); this section only
// executes it and logs what happened.

/** Tables that were already non-empty right after boot: the reset's protected set. */
let seedTablesSnapshot = null;

/** Round-1 stack boot duration (ms), the denominator of the M5 warm-start ratio. */
let stackBootElapsedMs = null;

/** Between-round reset duration (ms) of the most recent retry, the numerator of that ratio. */
let lastRoundResetMs = null;

async function stopRunnerService(name) {
  const child = nativeServiceChildren.get(name);
  if (!child) return;
  try {
    await stopProcess(child);
    await waitForChildExit(child);
  } catch (error) {
    // Already gone is the good case; anything else is logged and the reset decides what to do.
    console.warn(`[e2e-host] round reset: stopping ${name} reported ${error instanceof Error ? error.message : String(error)}`);
  }
  for (let index = dockerProcesses.length - 1; index >= 0; index -= 1) {
    if (dockerProcesses[index].child === child) dockerProcesses.splice(index, 1);
  }
  nativeServiceChildren.delete(name);
}

async function startRunnerService(name) {
  const config = nativeServiceConfigs.get(name);
  if (!config) throw new Error(`round reset: ${name} is not runner-owned`);
  return launchNativeService(config);
}

/** Run one statement with psql inside the isolated PostgreSQL container and return stdout. */
async function psqlCapture(database, sqlText) {
  const outcome = await runCapture(dockerCommand, [
    'exec', `${pgProjectName}-postgres-1`,
    'psql', '-v', 'ON_ERROR_STOP=1', '-U', pgUser, '-d', database, '-tA', '-c', sqlText,
  ]);
  if (outcome.code !== 0) {
    throw new Error(`psql failed (exit=${outcome.code}) on ${database}: ${(outcome.stderr ?? '').slice(0, 500)}`);
  }
  return outcome.stdout ?? '';
}

function splitPsqlLines(stdout) {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

/** Snapshot the protected table set once, after boot and before the first spec runs. */
/** task-247: `pg_constraint` snapshot (direction preserved) used to extend the keep list. */
let foreignKeySnapshot = null;

async function captureSeedTables() {
  // task-247: deterministic `count(*)` per table instead of `pg_stat_user_tables.n_live_tup`.
  // The stats collector is asynchronous, so a table the CP seeded seconds ago could still read 0
  // and be classified "test data" ⇒ truncated on the retry, dropping the authorization surface
  // (`grants`/`role_bindings`) and turning `/api/v1/config/import` into 403. `count(*)` also makes
  // the snapshot independent of `ANALYZE` timing.
  const tables = splitPsqlLines(await psqlCapture(pgDatabase, buildDatabaseTablesQuery()));
  const counts = parseSeedCounts(await psqlCapture(pgDatabase, buildSeedCountQuery(tables)));
  foreignKeySnapshot = parseForeignKeySnapshot(
    await psqlCapture(pgDatabase, buildForeignKeySnapshotQuery()),
  );
  const rows = seedTablesFromCounts(counts);
  const authCounts = counts
    .filter((entry) => AUTHORIZATION_SURFACE_TABLES.includes(entry.table))
    .map((entry) => `${entry.table}=${entry.rowCount}`)
    .join(', ');
  if (rows.length === 0) {
    console.warn('[e2e-host] round reset: seed-table snapshot is empty — in-process retry will refuse to truncate');
  } else {
    console.log(
      `[e2e-host] round reset: protecting ${rows.length} seeded table(s) (deterministic count(*)): ${rows.join(', ')}`,
    );
  }
  console.log(`[e2e-host] round reset: auth surface at boot: ${authCounts}`);
  console.log(
    `[e2e-host] round reset: pg_constraint snapshot ${foreignKeySnapshot.length} FK edge(s)`,
  );
  return rows;
}

async function runDatabaseReset({ strategy, round }) {
  if (strategy === 'truncate') {
    const tables = splitPsqlLines(await psqlCapture(pgDatabase, buildDatabaseTablesQuery()));
    let plan = selectTablesToTruncate({ tables, seedTables: seedTablesSnapshot ?? [] });
    if (plan.refused) throw new Error(plan.refused);
    // task-247: `TRUNCATE … CASCADE` follows FKs from a referencing table to the referenced one.
    // A kept table that points at a to-be-truncated table would be truncated through it, so the
    // keep list is extended from the `pg_constraint` snapshot instead of trusting the static list.
    const referencedByKept = keepTablesReferencedByKept({
      truncate: plan.truncate,
      kept: plan.kept,
      foreignKeys: foreignKeySnapshot ?? [],
    });
    if (referencedByKept.length > 0) {
      console.log(
        `[e2e-host] round reset: keeping ${referencedByKept.length} table(s) referenced by kept tables (pg_constraint): ${referencedByKept.join(', ')}`,
      );
      plan = selectTablesToTruncate({
        tables,
        seedTables: [...(seedTablesSnapshot ?? []), ...referencedByKept],
      });
      if (plan.refused) throw new Error(plan.refused);
    }
    if (plan.truncate.length === 0) {
      console.warn('[e2e-host] round reset: no test-data tables to truncate (fresh database?)');
      return;
    }
    const authTables = [...AUTHORIZATION_SURFACE_TABLES].filter((name) => tables.includes(name));
    const authBefore = parseSeedCounts(await psqlCapture(pgDatabase, buildSeedCountQuery(authTables)));
    console.log(`[e2e-host] round reset: truncated ${plan.truncate.length} table(s): ${plan.truncate.join(', ')}`);
    console.log(`[e2e-host] round reset: kept ${plan.kept.length} table(s): ${plan.kept.join(', ')}`);
    console.log(
      `[e2e-host] round reset: auth surface before: ${authBefore.map((entry) => `${entry.table}=${entry.rowCount}`).join(', ')}`,
    );
    await psqlCapture(pgDatabase, buildTruncateSql({ tables: plan.truncate }));
    const authAfter = parseSeedCounts(await psqlCapture(pgDatabase, buildSeedCountQuery(authTables)));
    console.log(
      `[e2e-host] round reset: auth surface after: ${authAfter.map((entry) => `${entry.table}=${entry.rowCount}`).join(', ')}`,
    );
    return;
  }
  // `template` and `dump-restore` drop the database, so the services must be out of the way first.
  const container = `${pgProjectName}-postgres-1`;
  const dumpPath = `/tmp/xihe-round-${round}-schema.sql`;
  const commands = buildDumpRestoreCommands({ container, database: pgDatabase, user: pgUser, dumpPath });
  const dump = await run(commands.dump.program, commands.dump.args, { stdio: 'inherit' });
  if (dump.code !== 0) throw new Error(`pg_dump --schema-only failed (exit=${dump.code})`);

  if (strategy === 'template') {
    const template = `${pgDatabase}_tpl`;
    const exists = (await psqlCapture('postgres', buildDatabaseExistsQuery(template))).trim() === '1';
    if (!exists) {
      await psqlCapture('postgres', buildBlankDatabaseResetSql({ database: template })[1]);
      const load = buildDumpRestoreCommands({ container, database: template, user: pgUser, dumpPath }).restore;
      const loaded = await run(load.program, load.args, { stdio: 'inherit' });
      if (loaded.code !== 0) throw new Error(`template schema load failed (exit=${loaded.code})`);
      console.log(`[e2e-host] round reset: template database ${template} prepared once`);
    }
    for (const statement of buildTemplateResetSql({ database: pgDatabase, template })) {
      await psqlCapture('postgres', statement);
    }
    console.log(`[e2e-host] round reset: recreated ${pgDatabase} from template ${template}`);
    return;
  }
  for (const statement of buildBlankDatabaseResetSql({ database: pgDatabase })) {
    await psqlCapture('postgres', statement);
  }
  const restore = await run(commands.restore.program, commands.restore.args, { stdio: 'inherit' });
  if (restore.code !== 0) throw new Error(`schema restore failed (exit=${restore.code})`);
  console.log(`[e2e-host] round reset: recreated ${pgDatabase} from pg_dump --schema-only`);
}

async function resetRoundState({ round, strategy }) {
  const began = Date.now();
  const restartServices = strategy !== 'truncate';
  try {
    if (restartServices) {
      await stopRunnerService('agent');
      await stopRunnerService('control-plane');
    }
    await runDatabaseReset({ strategy, round });
    if (restartServices) {
      // Same ordering the boot path enforces: the Agent's startup config sync fails closed
      // without a healthy CP.
      await startRunnerService('control-plane');
      await waitForHttp('cp-after-round-reset', `http://127.0.0.1:${cpPort}/actuator/health`, readinessTimeoutMs, {});
      await startRunnerService('agent');
      await waitForHttp('agent-after-round-reset', `http://127.0.0.1:${agentPort}/internal/v1/agent/health`, readinessTimeoutMs, {});
    }
    // Identity and config from the failed round are stale by construction: re-bootstrap and
    // re-import exactly like the boot path does, then re-arm the readiness gate.
    await configureFakeLlm();
    await waitForAgentLlmReady({
      healthUrl: `http://127.0.0.1:${agentPort}/internal/v1/agent/health`,
      expectReady: llmMode !== 'missing',
      timeoutMs: readinessTimeoutMs,
    });
    const elapsedMs = Date.now() - began;
    lastRoundResetMs = elapsedMs;
    console.log(`[e2e-host] round ${round}: state reset in ${(elapsedMs / 1000).toFixed(2)}s (strategy=${strategy})`);
    return { ok: true, elapsedMs };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[e2e-host] round ${round}: in-process reset failed, not retrying — ${message}`);
    return { ok: false, message };
  }
}

async function restartNativeService(name) {
  const config = nativeServiceConfigs.get(name)
  const previous = nativeServiceChildren.get(name)
  if (!config || !previous || !previous.pid) {
    throw new Error('requested service is not runner-owned')
  }
  const previousPid = previous.pid
  await stopProcess(previous)
  await waitForChildExit(previous)
  for (let index = dockerProcesses.length - 1; index >= 0; index -= 1) {
    if (dockerProcesses[index].child === previous) dockerProcesses.splice(index, 1)
  }
  nativeServiceChildren.delete(name)

  const replacement = await launchNativeService(config)
  const pidChanged = Boolean(replacement.pid && replacement.pid !== previousPid)
  if (!pidChanged) {
    await stopProcess(replacement)
    throw new Error('runner-owned service process identity did not change')
  }
  console.log(`[e2e-host] checkpoint probe restarted ${name}; pidChanged=${pidChanged}`)
  return { service: name, pidChanged }
}

function runScratchCheckpointMigrationRecovery() {
  const container = `${pgProjectName}-postgres-1`
  const scratchPrefix = `xihe_cp_probe_${e2eRunId.replace(/[^a-z0-9]/gi, '_')}`
  const scratchName = `${scratchPrefix}_${randomBytes(4).toString('hex')}`
  if (
    !/^xihe_cp_probe_[a-z0-9_]+_[0-9a-f]{8}$/.test(scratchName) ||
    !scratchName.startsWith(`${scratchPrefix}_`) ||
    scratchName === pgDatabase
  ) {
    throw new Error('scratch database identity validation failed')
  }
  const migrationPath = join(
    projectDir,
    'packages',
    'control-plane',
    'src',
    'main',
    'resources',
    'db',
    'migration',
    'V72__agent_graph_checkpoints.sql',
  )
  if (!existsSync(migrationPath)) throw new Error('checkpoint migration source is unavailable')
  const migrationSql = readFileSync(migrationPath, 'utf8')
  const targetTables = [
    'agent_graph_checkpoint_lineages',
    'agent_graph_checkpoints',
    'agent_graph_checkpoint_writes',
  ]
  const execPsql = (database, sql, { input = undefined } = {}) => execFileSync(
    dockerCommand,
    [
      'exec',
      ...(input === undefined ? [] : ['-i']),
      container,
      'psql',
      '-X',
      '-q',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      pgUser,
      '-d',
      database,
      ...(input === undefined ? ['-c', sql] : ['-f', '-']),
    ],
    {
      input,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      stdio: input === undefined ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'pipe', 'ignore'],
    },
  ).trim()
  const tableCount = () => {
    const names = targetTables.map((name) => `'${name}'`).join(', ')
    const value = execPsql(
      scratchName,
      `SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN (${names})`,
    )
    if (!/^\d+$/.test(value)) throw new Error('scratch migration table count is invalid')
    return Number(value)
  }
  const createScratch = () => execPsql('postgres', `CREATE DATABASE ${scratchName}`)
  const dropScratch = () => execPsql('postgres', `DROP DATABASE IF EXISTS ${scratchName}`)
  let createAttempted = false
  let failedMigrationRolledBack = false
  let rollbackTableCount = -1
  let recoveredTableCount = -1
  let cleanupSucceeded = false
  try {
    createAttempted = true
    createScratch()
    execPsql(
      scratchName,
      'CREATE TABLE sessions (id uuid PRIMARY KEY); ' +
        'CREATE TABLE session_branches (' +
        'session_id uuid NOT NULL, id uuid NOT NULL, PRIMARY KEY (session_id, id), ' +
        'FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE);',
    )
    const interruptionMarker = 'xihe_checkpoint_migration_before_interruption'
    try {
      execPsql(scratchName, '', {
        input: `BEGIN;\n${migrationSql}\nSELECT '${interruptionMarker}';\nSELECT 1 / 0;\nCOMMIT;\n`,
      })
    } catch (error) {
      const output = typeof error?.stdout === 'string'
        ? error.stdout
        : Buffer.isBuffer(error?.stdout)
          ? error.stdout.toString('utf8')
          : ''
      failedMigrationRolledBack = error?.status !== 0 && output.includes(interruptionMarker)
    }
    rollbackTableCount = tableCount()
    if (!failedMigrationRolledBack || rollbackTableCount !== 0) {
      throw new Error('interrupted migration did not roll back cleanly')
    }
    execPsql(scratchName, '', { input: `BEGIN;\n${migrationSql}\nCOMMIT;\n` })
    recoveredTableCount = tableCount()
    if (recoveredTableCount !== targetTables.length) {
      throw new Error('scratch migration replay did not create the expected schema')
    }
  } finally {
    if (createAttempted) {
      dropScratch()
      cleanupSucceeded = execPsql(
        'postgres',
        `SELECT count(*) FROM pg_database WHERE datname='${scratchName}'`,
      ) === '0'
    }
  }
  if (!cleanupSucceeded) throw new Error('scratch database cleanup could not be verified')
  return {
    migrationFailed: failedMigrationRolledBack,
    rollbackTableCount,
    recoveredTableCount,
    cleanupSucceeded,
  }
}

function readControlRequestBody(request, maxBytes = 4_096) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('control request too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.once('error', reject)
  })
}

function sendControlJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'close',
  })
  response.end(JSON.stringify(value))
}

/**
 * BL-538: read AND consume a declared stop window for one service.
 *
 * Single-use on purpose: the first exit consumes the declaration, so a second non-zero exit inside
 * the same window (a crash-restart loop) goes back to the normal `fail` path instead of being
 * forgiven repeatedly. Invalid/expired declarations return an intent with `matches` false (or
 * null), which classifies as `fail` — a stale marker must never widen the exception.
 */
function takeDeclaredServiceExit(service) {
    if (!declaredExitDir) return null
    const file = join(declaredExitDir, `${service}.json`)
    if (!existsSync(file)) return null
    let parsed = null
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
        parsed = null
    } finally {
        try { unlinkSync(file) } catch { /* already consumed/removed */ }
    }
    if (!parsed || typeof parsed !== 'object') return null
    const startedAt = Number(parsed.startedAt)
    const expiresAt = Number(parsed.expiresAt)
    if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) return null
    const spec = typeof parsed.spec === 'string' && parsed.spec.trim() ? parsed.spec.slice(0, 200) : 'unknown-spec'
    return { spec, startedAt, expiresAt, matches: Date.now() <= expiresAt }
}

async function startCheckpointProbeControl() {
  if (!exactCheckpointHostProbeRequested || externalServer || isPersistent) {
    throw new Error('checkpoint probe control is limited to an owned exact-spec host run')
  }
  checkpointProbeControlToken = randomBytes(32).toString('base64url')
  const expected = Buffer.from(`Bearer ${checkpointProbeControlToken}`, 'utf8')
  checkpointProbeControlServer = createHttpServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? '', 'utf8')
    const authorized = supplied.length === expected.length && timingSafeEqual(supplied, expected)
    if (!authorized) {
      request.resume()
      sendControlJson(response, 401, { error: 'unauthorized' })
      return
    }
    const allowedPaths = ['/restart-service', '/migration-recovery']
    if (checkpointResumeRequested) allowedPaths.push('/resume-fixture')
    if (request.method !== 'POST' || !allowedPaths.includes(request.url ?? '')) {
      request.resume()
      sendControlJson(response, 404, { error: 'not found' })
      return
    }
    try {
      const rawBody = await readControlRequestBody(request)
      const body = JSON.parse(rawBody || '{}')
      if (request.url === '/resume-fixture') {
        if (
          !body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !['state', 'arm-ambiguous', 'reset'].includes(body.action)
        ) {
          sendControlJson(response, 400, { error: 'invalid resume fixture request' })
          return
        }
        const fixtureResponse = await fetch(`http://127.0.0.1:${fakeMcpPort}/__e2e/checkpoint-resume`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${fakeMcpResumeControlToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: body.action }),
          signal: AbortSignal.timeout(5_000),
        })
        if (!fixtureResponse.ok) throw new Error('resume fixture control failed')
        sendControlJson(response, 200, await fixtureResponse.json())
        return
      }
      if (request.url === '/restart-service') {
        if (
          !body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).length !== 1 || !['agent', 'control-plane'].includes(body.service)
        ) {
          sendControlJson(response, 400, { error: 'invalid service restart request' })
          return
        }
        const restarted = await restartNativeService(body.service)
        sendControlJson(response, 200, restarted)
        return
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
        sendControlJson(response, 400, { error: 'invalid migration recovery request' })
        return
      }
      const migration = runScratchCheckpointMigrationRecovery()
      sendControlJson(response, 200, migration)
    } catch (error) {
      // Server-side only: the HTTP body stays generic, but hiding the cause entirely made
      // the V1 scratch-migration failure undiagnosable. Loopback + token-gated control.
      console.error(`[e2e-host] checkpoint probe control failed: ${error?.message ?? error}`)
      sendControlJson(response, 500, { error: 'checkpoint probe control operation failed' })
    }
  })
  await new Promise((resolve, reject) => {
    checkpointProbeControlServer.once('error', reject)
    checkpointProbeControlServer.listen(0, '127.0.0.1', resolve)
  })
  const address = checkpointProbeControlServer.address()
  if (!address || typeof address === 'string') throw new Error('checkpoint probe control did not bind a TCP port')
  checkpointProbeControlUrl = `http://127.0.0.1:${address.port}`
  console.log('[e2e-host] checkpoint probe control bound to loopback')
}

async function closeCheckpointProbeControl() {
  if (checkpointProbeControlServer) {
    const server = checkpointProbeControlServer
    checkpointProbeControlServer = null
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
  checkpointProbeControlToken = null
  checkpointProbeControlUrl = null
}

async function launchUIVite() {
  console.log('[e2e-host] launching UI Vite')
  // task-237（坑 8）：候选 worktree 可能从未 `pnpm install` —— 此时 Vite 启动只会抛
  // "Cannot find module .../vite/bin/vite.js"，对操作者不可读、且发生在 boot 中段。
  // 启动前预检 `node_modules/vite` 并给一条可直接照抄的修复命令。
  const viteEntry = join(uiDir, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteEntry)) {
    throw new Error(
      `UI dependencies are missing: ${viteEntry} not found (this worktree never ran pnpm install).\n`
        + '  Fix: cd packages/ui && pnpm install --offline   (or: mise run setup:ui)',
    )
  }
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

async function fixtureAlive(port) {
  return await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })
    .then((response) => response.ok)
    .catch(() => false)
}

function describeFixtures() {
  const fixtures = [
    { name: 'Fake OAuth', script: 'fake-oauth-server.mjs', port: fakeOAuthPort, env: {
      XIHE_FAKE_OAUTH_PORT: fakeOAuthPort,
      XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
    } },
    { name: 'Fake MCP', script: 'fake-mcp-server.mjs', port: fakeMcpPort, env: {
      XIHE_FAKE_MCP_PORT: fakeMcpPort,
      XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
      XIHE_FAKE_MCP_CHECKPOINT_RESUME: checkpointResumeRequested ? '1' : '0',
      ...(checkpointResumeRequested ? { XIHE_FAKE_MCP_CONTROL_TOKEN: fakeMcpResumeControlToken } : {}),
    } },
  ]
        if (!realXiaomiKey) {
            // The fake LLM also serves the mock lane: PLAN-0439 chat always
            // goes through a ProviderConnection, so the mock lane needs a
            // reachable OpenAI-compatible endpoint for bound sessions even
            // though the legacy path still resolves provider=mock.
            fixtures.push({ name: 'Fake LLM', script: 'fake-llm-server.mjs', port: fakeLlmPort, env: {
                XIHE_FAKE_LLM_PORT: fakeLlmPort,
                XIHE_FAKE_LLM_MODE: llmMode,
            } })
  }
  return fixtures
}

async function startFixtures(only = null) {
  const fixtures = describeFixtures().filter(({ name }) => !only || only.includes(name))
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

// PLAN-0648 对账修复（Lead 2026-11-04 A 类授权）：task-24 的严格解析要求
// "instance profile → 消费用户自己的 USER 连接（providerId+connectionKey+READY）"，
// 而本文件的 fake import 只写 profile 不建连接（见下方「连接靠 spec 自建」注释）
// ⇒ goldpath admin 用 UI 建会话必 409 LLM_PROFILE_CONFLICT（窗口 3 G2-e :921 实测）。
// 补齐：为 token 主体建一条 connectionKey='default' 的 USER 连接并 verify 到 READY。
// 幂等：reuse/external 轮会重复进入——已存在则只补 verify。
// BL-204 之后 fake/real 两分支共用：real 分支传真实 key/model 与 MiMo baseUrl（不带 fakeLlmPort）。
async function ensureDefaultFakeConnection({ cpBaseUrl, accessToken, apiKey, modelId, realBase }) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
  const list = await fetch(`${cpBaseUrl}/api/v1/provider-connections`, { headers })
  if (!list.ok) {
    throw new Error(`provider-connections list failed: HTTP ${list.status} ${(await list.text()).slice(0, 300)}`)
  }
  const listBody = await list.json()
  const rows = Array.isArray(listBody) ? listBody : (listBody.connections ?? [])
  let connection = rows.find(
    (row) => row.providerId === 'openai' && row.connectionKey === 'default',
  )
  if (!connection) {
    const created = await fetch(`${cpBaseUrl}/api/v1/provider-connections`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        providerId: 'openai',
        apiTypeId: 'openai-chat-completions',
        apiTypeVersion: 1,
        apiKey: apiKey ?? 'sk-fake-openai-key',
        connectionKey: 'default',
        label: realBase ? 'e2e real LLM (default)' : 'e2e fake LLM (default)',
        scope: 'USER',
        modelDiscovery: 'manual',
        manualModels: [modelId ?? 'fake-openai'],
        ...(realBase ? { baseUrl: realBase } : { baseUrl: `http://127.0.0.1:${fakeLlmPort}/openai/v1` }),
      }),
    })
    if (!created.ok) {
      throw new Error(
        `default fake connection create failed: HTTP ${created.status} ${(await created.text()).slice(0, 300)}`,
      )
    }
    connection = await created.json()
  }
  if (connection.status !== 'READY') {
    const verified = await fetch(
      `${cpBaseUrl}/api/v1/provider-connections/${connection.id}/verify`,
      { method: 'POST', headers },
    )
    if (!verified.ok) {
      throw new Error(
        `default fake connection verify failed: HTTP ${verified.status} ${(await verified.text()).slice(0, 300)}`,
      )
    }
  }
  console.log(
    `[e2e-host] default fake connection ensured key=default status=${connection.status ?? 'READY'}`,
  )
}

async function configureFakeLlm() {
  const cpBaseUrl = `http://127.0.0.1:${cpPort}`
  const login = await fetch(`${cpBaseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: 'admin@xihe.local', password: e2eAdminPassword }),
  })
  if (!login.ok) throw new Error(`fake LLM admin login failed: HTTP ${login.status}`)
  const loginBody = await login.json()
  if (typeof loginBody?.accessToken !== 'string' || loginBody.accessToken.length === 0) {
    const responseKeys = loginBody && typeof loginBody === 'object'
      ? Object.keys(loginBody).sort().join(',')
      : '<non-object>'
    throw new Error(`fake LLM admin login response omitted accessToken; responseKeys=${responseKeys}`)
  }
  console.log(`[e2e-host] fake LLM admin login responseKeys=${Object.keys(loginBody).sort().join(',')} accessTokenChars=${loginBody.accessToken.length} tokenType=${loginBody.tokenType ?? '<missing>'}`)
  const accessToken = loginBody.accessToken

  if (realXiaomiKey) {
    // PLAN-0372 decision #A: the default native route (tools rejected by
    // design). PLAN-0372 decision #B: `openai-compat` reuses the same MiMo
    // endpoint/key through the OpenAI-compatible provider (tools work).
    // PLAN-0504: the default identity is the whole profile unit; base URLs no
    // longer travel through config (connection grants / env only).
    const llmProvider = realRoute === 'openai-compat'
      ? { profile: { providerId: 'openai', connectionKey: 'default', model: 'mimo-v2.6-flash' } }
      : { profile: { providerId: 'xiaomi', connectionKey: 'default', model: 'mimo-v2.6-flash' } }
    const imported = await fetch(`${cpBaseUrl}/api/v1/config/import`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 'llm-provider': llmProvider }),
    })
    if (!imported.ok) {
      const problem = await imported.text()
      throw new Error(`real provider config import failed: HTTP ${imported.status} ${problem.slice(0, 500)}`)
    }
    console.log(`[e2e-host] real provider configuration imported route=${realRoute} (key stays in the Agent env only)`)
    // task-24 严格解析的另一半对 real lane 同样成立：instance profile 引用
    // {providerId:openai, connectionKey:'default'}，而 strict resolve 要求消费用户自己有一条
    // USER+READY+key='default' 的连接（PLAN-0648 fake 分支已修，real 分支同批补齐，否则
    // spec 自建 key='plan0630-*' 的连接救不了解析）。幂等：已存在则只在非 READY 时补 verify。
    // PLAN-0650 M4 V5 缺陷修复：real 分支的 baseUrl 兜底不得回落到 fake LLM 端口
    // （real lane 不起 fake fixture，回落值指向死端口）；未显式给 base 时与 Agent env
    // 同源，取 lib/llm-env.mjs 的 DEFAULT_REAL_API_BASE。
    await ensureDefaultFakeConnection({
      cpBaseUrl,
      accessToken,
      apiKey: process.env.XIHE_E2E_REAL_XIAOMI_KEY,
      modelId: 'mimo-v2.6-flash',
      realBase: process.env.XIHE_E2E_REAL_OPENAI_BASE ?? DEFAULT_REAL_API_BASE,
    })
    return
  }
  // PLAN-0504: the default identity is the whole `profile` unit (providerId /
  // connectionKey / model) at the instance layer (no connection validation).
  // `mock` writes an explicit mock profile so readiness is genuinely ready
  // (decision #10 removed the implicit mock default); `missing` keeps the
  // domain empty and is expected to report not-ready. Fake endpoints are
  // reached through spec-created connections (`ensureChatBinding`); config
  // carries no base URLs anymore.
  const config = llmMode === 'missing'
    ? {}
    : llmMode === 'mock'
      ? {
          'llm-provider': {
            profile: { providerId: 'openai', connectionKey: 'default', model: 'mock' },
          },
        }
      : {
          'llm-provider': {
            profile: { providerId: 'openai', connectionKey: 'default', model: 'fake-openai' },
          },
        }
  if (Object.keys(config).length === 0) {
    console.log(`[e2e-host] llm-provider config skipped mode=${llmMode} (no profile; readiness stays not-ready)`)
    return
  }
  const imported = await fetch(`${cpBaseUrl}/api/v1/config/import`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  })
  if (!imported.ok) {
    const problem = await imported.text()
    throw new Error(`fake LLM config import failed: HTTP ${imported.status} ${problem.slice(0, 500)}`)
  }
  console.log(`[e2e-host] fake LLM configuration imported mode=${llmMode}`)
  // task-24 严格解析的另一半：profile 引用 key='default'，连接必须真实存在且 READY。
  await ensureDefaultFakeConnection({ cpBaseUrl, accessToken })
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

// PLAN-0579 R2: resolve the runtime binary across an external CARGO_TARGET_DIR.
// `cargo run` honors CARGO_TARGET_DIR (passed through by the runtime launch
// below), so the artifact may live outside packages/runtime/target. Candidates
// mirror cargo's resolution: external debug/release first, then the in-tree
// debug/release profiles. A miss is reported with every probed path.
function resolveRuntimeBinary() {
  const exe = process.platform === 'win32' ? 'xihe-runtime.exe' : 'xihe-runtime'
  const inTreeTarget = join(projectDir, 'packages', 'runtime', 'target')
  const candidates = process.env.CARGO_TARGET_DIR
    ? [join(process.env.CARGO_TARGET_DIR, 'debug', exe), join(process.env.CARGO_TARGET_DIR, 'release', exe)]
    : []
  candidates.push(join(inTreeTarget, 'debug', exe), join(inTreeTarget, 'release', exe))
  return { path: candidates.find((candidate) => existsSync(candidate)) ?? null, candidates }
}

async function runPlaywright() {
  // PLAN-0375: runner-owned flags must never reach the Playwright CLI. The lists live at module
  // scope (`RUNNER_ONLY_ARGS`/`RUNNER_ONLY_PREFIXES`) so the PLAN-0664 CLI preflight and this
  // passthrough compute "positional specs" from exactly the same rule set.
  const testArgs = playwrightPassthroughArgs
  let playwrightTestArgs = [...batchSpecs, ...testArgs]
  if (playwrightTestArgs.length === 0) playwrightTestArgs = ['e2e/real']
  // PLAN-0375 (R7): --report-name pins the JSON report under .local/dev
  // without depending on a hand-exported PLAYWRIGHT_JSON_OUTPUT_NAME.
  const reportPath = reportName
    ? (isAbsolute(reportName) ? reportName : join(projectDir, '.local', 'dev', reportName))
    : ''
  const hasReporter = playwrightTestArgs.some((arg) => arg === '--reporter' || arg.startsWith('--reporter='))
  // BL-421: the count assertions need a machine-readable reporter. When the caller brought its
  // own `--reporter` we cannot inject `json` without dropping theirs, so the counts are simply
  // not asserted for that run — but `--expect-tests` explicitly asked for them, so that
  // combination is refused instead of quietly degrading to "no assertion at all".
  const statsPath = hasReporter
    ? ''
    : (reportPath || join(projectDir, '.local', 'dev', `e2e-host-stats-${runIdForTests}.json`))
  if (hasReporter && expectTests !== null) {
    throw new Error('[e2e-host] --expect-tests needs the runner-owned JSON reporter; drop your --reporter or drop --expect-tests')
  }
  if (!hasReporter) playwrightTestArgs = ['--reporter=list,json', ...playwrightTestArgs]
  // PLAN-0631: 用户传的 --grep 必须与车道的 @host 门**合并成单个正则**，不能追加第二个
  // --grep —— Playwright 多只取最后一个，会**静默覆盖**用户的过滤（实测：`--grep S6`
  // 实际跑了全链 7 passed）。顺序无关：测试名里 S6 可能出现在 @host 前或后。
  let userGrep = null
  {
    const merged = []
    for (let i = 0; i < playwrightTestArgs.length; i += 1) {
      const arg = playwrightTestArgs[i]
      if (arg === '--grep') { userGrep = playwrightTestArgs[i + 1] ?? null; i += 1; continue }
      if (arg.startsWith('--grep=')) { userGrep = arg.slice('--grep='.length); continue }
      merged.push(arg)
    }
    playwrightTestArgs = merged
  }
  if (userGrep) {
    // 退化情形（PLAN-0658 实测）：用户 grep 本身**已经含 `@host`**（如 headed 场景
    // `--grep 'R4@host'`）。此时再套 "(?:grep)…@host | @host…(?:grep)" 会要求标题里出现
    // **两次** `@host`，结果 `No tests found`（假阴性，看起来像参数没透传）。它已满足车道门，
    // 直接原样使用即可 —— 只加这一个分支，其它参数解析逻辑不变。
    const alreadyLaneTagged = /@host/i.test(userGrep)
    playwrightTestArgs.push(
      '--grep',
      alreadyLaneTagged
        ? userGrep
        : `(?:${userGrep})[\\s\\S]*@host|@host[\\s\\S]*(?:${userGrep})`,
    )
  }
  if (reportPath) console.log(`[e2e-host] JSON report → ${reportPath}`)
  // PLAN-0579 R2: specs that restart the Runtime (journey-b B1) must spawn the
  // same binary the runner launched, resolved across an external CARGO_TARGET_DIR.
  const runtimeBinary = resolveRuntimeBinary()
  if (runtimeBinary.path) {
    console.log(`[e2e-host] runtime binary for spec restarts: ${runtimeBinary.path}`)
  } else {
    console.warn(`[e2e-host] runtime binary not found; probed: ${runtimeBinary.candidates.join(', ')}`)
  }
  // PLAN-0369: the Agent binds one MCP workspace per process. Specs that move
  // between workspaces restart the Agent through `ensureAgentWorkspaceBinding`
  // and need the exact provider/credential env the Agent was launched with.
  // PLAN-0372 (BL-28) decisions #A/#B: the real-provider lane restarts through
  // the same contract so a full real run can rebind across spec-local
  // workspaces; the contract follows the selected real route fixture (`native`
  // -> XIHE_XIAOMI_API_KEY, `openai-compat` -> XIHE_OPENAI_API_KEY). The key
  // value is the same one the runner already passes down the process tree (env
  // inheritance); it stays in memory only and is never logged.
  //
  // PLAN-0650 B-1: the LLM portion now comes from `lib/llm-env.mjs` — the SAME
  // function the initial launch uses. Two hand-maintained copies had drifted (the
  // fake lane learned to set XIHE_API_BASE, the real lane never did), and the real
  // `openai-compat` route fell through to api.openai.com. One function removes that
  // class of bug; both real routes now pin XIHE_API_BASE explicitly.
  const agentRestartEnv = llmEnv({
    realKey: realXiaomiKey,
    realRoute,
    llmMode,
    fakeLlmPort,
    realApiBase: process.env.XIHE_E2E_REAL_API_BASE,
  })
  // PLAN-0588 T4.2a (M4 gate passed 2026-10-31): one Agent process keeps a
  // per-workspace MCP shard, so a spec no longer needs a process restart to
  // switch workspace. `disabled` turns journey.ensureAgentWorkspaceBinding into
  // a no-op that logs once; deleting this single key restores rebinding
  // (spec/e2e-rebind-exit.md §4 rollback).
  agentRestartEnv.disabled = 'BL-141 fixed (0588 M1-M3)'
  if (checkpointSaverProbeRequested) {
    agentRestartEnv.XIHE_E2E_PROFILE = 'host'
    agentRestartEnv.XIHE_E2E_CHECKPOINT_PROBE = '1'
  }
  if (checkpointResumeRequested) {
    agentRestartEnv.XIHE_E2E_PROFILE = 'host'
    agentRestartEnv.XIHE_E2E_CHECKPOINT_RESUME = '1'
  }
  // PLAN-0631: 不再经 pnpm.cmd → cmd.exe 转发（argv 数组语义在 cmd 拼接层会丢：
  // 含 `|` 的合并 grep 正则曾被当成管道符 ⇒ EPIPE；且 cmd 对引号/管道组合的解析
  // 有实测不可收敛的怪癖——同类 shape 一个清一个浊）。直接 node 跑 playwright CLI，
  // spawn 保持 argv 语义，正则/空格/引号类参数全都不再经过 shell 解析。
  const cliCandidates = [
    join(uiDir, 'node_modules', 'playwright', 'cli.js'),
    // pnpm 布局兜底：node_modules/playwright 是指向 .pnpm 虚拟店的 symlink，
    // 个别工具链（junction 链上的 realpath）解不开时走 .pnpm 直链。
    join(uiDir, 'node_modules', '.pnpm', 'node_modules', 'playwright', 'cli.js'),
  ]
  const playwrightCli = cliCandidates.find((candidate) => existsSync(candidate))
  if (!playwrightCli) {
    throw new Error(`[e2e-host] playwright CLI not found (tried: ${cliCandidates.join(', ')})`)
  }
  // BL-538: fresh per-run directory for declared stop windows (wiped with the run dir).
  declaredExitDir = join(hostRootParent, runIdForTests, 'expected-exits')
  await mkdir(declaredExitDir, { recursive: true }).catch((error) => {
    console.warn(`[e2e-host] declared-exit dir unavailable (${error instanceof Error ? error.message : String(error)}); declared windows disabled`)
    declaredExitDir = null
  })
  const result = await run(nodeCommand, [
    playwrightCli,
    'test',
    '--config',
    'e2e/playwright.config.ts',
    ...playwrightTestArgs,
    // 用户 --grep 已在上方与 @host 合并进单个正则；无用户 --grep 时维持车道门。
    ...(userGrep ? [] : ['--grep', '@host']),
    '--workers',
    workerCount,
  ], {
    cwd: uiDir,
    env: {
      XIHE_E2E_PROFILE: 'host',
      XIHE_E2E_EXTERNAL_SERVER: '1',
      XIHE_E2E_RUN_ID: runIdForTests,
      // BL-560: the per-round RUN_ID above rotates (`-r2`, ...) but the host root is
      // process-level fixed (e2e-host.mjs:369). Specs that resolve evidence/artifacts
      // from the host root (checkpoint-rollback/slices, bl382, attachment-preview-budget,
      // ...) previously fell back to `path.join(..., '.tmp/e2e-host', <RUN_ID>)` and so
      // read a wrong, per-round root on round 2+. Passing the real hostRoot lets every
      // spec read the same process-level root the runner and native services use.
      XIHE_WORKSPACE_HOST_ROOT: hostRoot,
      // BL-538: specs declare an intentional service stop here (see takeDeclaredServiceExit).
      ...(declaredExitDir ? { XIHE_E2E_EXPECTED_EXIT_DIR: declaredExitDir } : {}),
      XIHE_CP_API_TOKEN: serviceToken,
      XIHE_UI_PORT: uiPort,
      XIHE_CP_PORT: cpPort,
      XIHE_AGENT_PORT: agentPort,
      XIHE_RUNTIME_PORT: runtimePort,
      // PLAN-0579 R2: injected for journey-b's B1 runtime restart; specs fall
      // back to the same multi-candidate resolution when absent.
      ...(runtimeBinary.path ? { XIHE_RUNTIME_EXE: runtimeBinary.path } : {}),
      XIHE_FAKE_OAUTH_PORT: fakeOAuthPort,
      XIHE_FAKE_LLM_PORT: fakeLlmPort,
      XIHE_FAKE_MCP_PORT: fakeMcpPort,
      XIHE_FAKE_MCP_ACCESS_TOKEN: fakeMcpAccessToken,
      // Test-only fixture metadata. The password remains inside the isolated
      // Postgres container; host specs seed narrowly scoped grants via docker exec.
      XIHE_E2E_PG_CONTAINER: `${pgProjectName}-postgres-1`,
      XIHE_E2E_PG_DATABASE: pgDatabase,
      XIHE_E2E_PG_USER: pgUser,
      XIHE_E2E_PG_PORT: pgPort,
      XIHE_E2E_LLM_MODE: llmMode,
      // PLAN-0566 D6: expose the selected auth lane so auth-lane specs can gate
      // themselves (skip in the default `exempt` full-matrix lane instead of
      // failing on thresholds that only the `ratelimit` lane lowers).
      XIHE_E2E_AUTH_LANE: authLane,
      XIHE_E2E_REGISTRATION_POLICY: registrationPolicy,
      XIHE_E2E_ADMIN_PASSWORD: e2eAdminPassword,
      XIHE_E2E_AGENT_RESTART_ENV: JSON.stringify(agentRestartEnv),
      XIHE_E2E_AGENT_DB_CONFIG_PRESENT: agentDatabaseConfigPresent === false ? 'false' : 'unknown',
      XIHE_E2E_CHECKPOINT_PROBE_ACTIVE: checkpointSaverProbeRequested ? 'true' : 'false',
      XIHE_E2E_CHECKPOINT_RESUME_ACTIVE: checkpointResumeRequested ? 'true' : 'false',
      ...(exactCheckpointHostProbeRequested
        ? {
            XIHE_E2E_HOST_CONTROL_URL: checkpointProbeControlUrl,
            XIHE_E2E_HOST_CONTROL_TOKEN: checkpointProbeControlToken,
          }
        : {}),
      // PLAN-0372 decisions #A/#B: the real-lane cases read the selected route
      // fixture (no secrets; mock lane ignores it).
      XIHE_E2E_REAL_ROUTE: realRoute,
      // BL-148: the real lane starts no fake-LLM fixture, so specs cannot build
      // the mock-lane chat connection. Expose the real provider identity to THIS
      // node test process only (never logged, never persisted, never forwarded to
      // the browser by our helpers) so `ensureChatBinding` can create a
      // manual-discovery connection that verifies READY without a network call.
      ...(realXiaomiKey
        ? {
            XIHE_E2E_REAL_KEY: realXiaomiKey,
            // 2026-11-05（Lead A 类授权）：real-Xiaomi 车道的历史 spec 直接读这个变量名
            // （`plan0630-delegation-walkthrough.spec.ts:126/:189`、`agent-spawn-caller.spec.ts` 等），
            // 只传 XIHE_E2E_REAL_KEY 会让它们自我 skip / 报 "real provider key is required"。
            // 只进 Playwright 子进程环境：不打印、不落盘、不进 argv。
            XIHE_E2E_REAL_XIAOMI_KEY: realXiaomiKey,
            XIHE_E2E_REAL_PROVIDER: realRoute === 'openai-compat' ? 'openai' : 'xiaomi',
            XIHE_E2E_REAL_API_TYPE_ID: realRoute === 'openai-compat' ? 'openai-chat-completions' : 'mimo-responses',
            XIHE_E2E_REAL_API_TYPE_VERSION: '1',
            // Both route fixtures use the same MiMo endpoint (PLAN-0372 #B).
            XIHE_E2E_REAL_BASE_URL: 'https://api.xiaomimimo.com/v1',
            XIHE_E2E_REAL_MODEL: 'mimo-v2.6-flash',
          }
        : {}),
      XIHE_E2E_HEADED: process.env.XIHE_E2E_HEADED ?? '0',
      XIHE_E2E_BROWSER_CHANNEL: process.env.XIHE_E2E_BROWSER_CHANNEL ?? 'chrome-beta',
      // 2026-11-06（PLAN-0684 窗口，Lead A 类授权）：mention-cursor 车道的三个
      // runner-owned 信号量在此显式透传（缺省不设置时零变化，specs 自我 skip 维持）。
      ...(process.env.XIHE_E2E_MENTION_CURSOR ? { XIHE_E2E_MENTION_CURSOR: process.env.XIHE_E2E_MENTION_CURSOR } : {}),
      ...(process.env.XIHE_DEMO_STATE_FILE ? { XIHE_DEMO_STATE_FILE: process.env.XIHE_DEMO_STATE_FILE } : {}),
      ...(process.env.XIHE_MENTION_CURSOR_DIR ? { XIHE_MENTION_CURSOR_DIR: process.env.XIHE_MENTION_CURSOR_DIR } : {}),
      // 2026-11-06（PLAN-0660 T5.23 窗口）：ask_user 真栈车道的门控与证据落点同样显式透传
      // （缺省不设置时零变化，spec 自我 skip 维持；卡片 testid 可先用 env 探一次）。
      ...(process.env.XIHE_E2E_ASK_USER
        ? { XIHE_E2E_ASK_USER: process.env.XIHE_E2E_ASK_USER }
        : {}),
      ...(process.env.XIHE_ASK_USER_DIR ? { XIHE_ASK_USER_DIR: process.env.XIHE_ASK_USER_DIR } : {}),
      ...(process.env.XIHE_ASK_USER_CARD_TESTID
        ? { XIHE_ASK_USER_CARD_TESTID: process.env.XIHE_ASK_USER_CARD_TESTID }
        : {}),
      ...(process.env.XIHE_ASK_USER_INPUT_TESTID
        ? { XIHE_ASK_USER_INPUT_TESTID: process.env.XIHE_ASK_USER_INPUT_TESTID }
        : {}),
      ...(process.env.XIHE_ASK_USER_SUBMIT_TESTID
        ? { XIHE_ASK_USER_SUBMIT_TESTID: process.env.XIHE_ASK_USER_SUBMIT_TESTID }
        : {}),
      ...(statsPath ? { PLAYWRIGHT_JSON_OUTPUT_NAME: statsPath } : {}),
    },
  })
  await assertExecutedTestCounts(result, statsPath)
  return result
}

/**
 * BL-421: a gated spec that self-skips still lets `playwright test` exit 0, so a lane could
 * report success while having executed nothing (the 0660 ask-user spec is exactly that shape:
 * `test.skip(!ENABLED, …)` behind `XIHE_E2E_ASK_USER`). Read the runner-owned JSON report and
 * make the numbers an explicit part of the verdict:
 *   - always print `executed/skipped/flaky/unexpected` so "1 skipped" cannot hide behind exit 0;
 *   - `--expect-tests=N` pins how many tests must have **executed** this round;
 *   - any skip fails the run unless `--allow-skip` was passed.
 * A missing/unparsable report is a hard error, never a pass: the whole point is that
 * "no evidence of execution" must not read as "green".
 */
async function assertExecutedTestCounts(result, statsPath) {
  if (!statsPath) return result
  let report
  try {
    report = JSON.parse(await readFile(statsPath, 'utf8'))
  } catch (error) {
    const message = `[e2e-host] BL-421: cannot read the Playwright JSON report at ${statsPath} (${error instanceof Error ? error.message : String(error)}); refusing to treat exit=${result.code} as a pass`
    console.error(message)
    return { ...result, code: result.code === 0 ? 1 : result.code }
  }
  const summary = summarizePlaywrightReport(report)
  console.log(`[e2e-host] ${formatTestCounts(summary)}`)
  const { ok, problems } = judgeTestCounts({ stats: summary, expectTests, allowSkip })
  if (ok) return result
  for (const problem of problems) console.error(`[e2e-host] BL-421 FAIL: ${problem}`)
  return { ...result, code: result.code === 0 ? 1 : result.code }
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
    //    PLAN-0650 M5 (T5.5) zero-residue note: the between-round reset leaves exactly two kinds of
    //    residue, and both live inside this project/volume — the template database
    //    (`<roundDb>_tpl`) and the schema dump in the container's /tmp. `down --volumes` below
    //    removes the volume that holds the template DB and destroys the container that holds the
    //    dump, so there is nothing extra to clean up on the host and no .gitignore entry to add.
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
  // task-257: shutdown window — child exits here are expected terminations, not run failures.
  shuttingDown = true
  lifecyclePhase = 'cleanup'
  // PLAN-294 appendix G-1: a failed run without --keep used to delete its
  // own logs with teardown, forcing a full rerun just to read an exception.
  // Preserve the run directory when the tests failed (recycled later by
  // normal .tmp hygiene); --keep still preserves everything unconditionally.
  const preserveRunDir = result && result.code !== 0
  if (preserveRunDir && existsSync(e2eLogDir)) {
    console.log(`[e2e-host] tests failed; preserving logs at ${e2eLogDir} (recycle with .tmp cleanup)`)
  }
  const controlFailures = []
  try {
    await closeCheckpointProbeControl()
  } catch {
    controlFailures.push('checkpoint probe control server shutdown failed')
  }
  try {
    const failures = await collectIsolatedResources(preserveRunDir)
    teardownResult = { ok: failures.length + controlFailures.length === 0, failures: [...controlFailures, ...failures] }
  } catch (error) {
    teardownResult = {
      ok: false,
      failures: [...controlFailures, `teardown crashed: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
  return teardownResult
}

// ③3 (PLAN-294 review): a running dev runtime holds xihe-runtime.exe, so
// `cargo run --bin xihe-runtime` fails with os error 5. Detect and say so —
// this cost a debugging round trip in PLAN-294 M0.
// task-237: `docker compose up -d` 返回只代表"容器已创建/已 recreate"，不代表 published 端口可用。
// 两次事故（15:42 / 16:24，不同端口、同样 `Connection refused` → CP exit 1）都发生在 `up` 之后的
// 几十毫秒窗口里。这里用 **容器身份** 硬等，避免把"上一次运行的旧容器 / recreate 中间态"当成就绪：
//   ① 容器存在且 State.Status=running；
//   ② 有 healthcheck 时 State.Health.Status 必须 healthy；
//   ③ State.StartedAt 必须晚于本次 `up` 的开始（证明是本轮新起的实例）。
async function waitForPostgresContainerHealthy(startedAtMs, timeoutMs = 60_000) {
  const container = `${pgProjectName}-postgres-1`
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    const inspect = await runCapture('docker', [
      'inspect', container,
      '-f', '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}|{{.Id}}',
    ])
    if (inspect.code === 0) {
      const [status, health, startedAt, id] = inspect.stdout.trim().split('|')
      last = `status=${status} health=${health} startedAt=${startedAt}`
      const startedAtDate = Date.parse(startedAt)
      const freshInstance = Number.isFinite(startedAtDate) ? startedAtDate >= startedAtMs - 2_000 : true
      if (status === 'running' && (health === 'healthy' || health === 'none') && freshInstance) {
        console.log(`[e2e-host] PostgreSQL container ready (${last}, id=${(id ?? '').slice(0, 12)})`)
        return
      }
      if (status === 'running' && (health === 'healthy' || health === 'none') && !freshInstance) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }
    } else {
      last = `inspect exit=${inspect.code} ${inspect.stderr?.trim() ?? ''}`
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(
    `PostgreSQL container ${container} did not become ready within ${timeoutMs}ms (last: ${last}); `
    + 'refusing to boot CP against an unpublishable/older container (task-237)',
  )
}

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

// PLAN-0584: pg_isready above runs inside the container and does not exercise
// the host-published port CP actually uses. On this Windows host the fresh
// port publish intermittently reset the first host-side connection during the
// PostgreSQL SSLRequest exchange (SocketException: Connection reset from
// ConnectionFactoryImpl.enableSSL), failing CP boot before any metadata path
// ran. Probe the exact wire path CP will use and require two consecutive
// answers before launching CP.
function probePostgresSslRequestOnce() {
  return new Promise((resolve) => {
    let settled = false
    const socket = connectTcp({ host: '127.0.0.1', port: pgPort })
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(2_000)
    socket.on('connect', () => {
      // SSLRequest: int32 length = 8, int32 request code = 80877103
      socket.write(Buffer.from([0x00, 0x00, 0x00, 0x08, 0x04, 0xd2, 0x16, 0x2f]))
    })
    socket.on('data', (chunk) => {
      // 'N' (0x4e) = SSL not supported, 'S' (0x53) = SSL requested; both prove
      // a live PostgreSQL wire response on the published port.
      finish(chunk.length > 0 && (chunk[0] === 0x4e || chunk[0] === 0x53))
    })
    socket.on('error', () => finish(false))
    socket.on('timeout', () => finish(false))
    socket.on('close', () => finish(false))
  })
}

async function waitForPostgresWireReady() {
  const deadline = Date.now() + 30_000
  let consecutive = 0
  while (Date.now() < deadline) {
    if (await probePostgresSslRequestOnce()) {
      consecutive += 1
      if (consecutive >= 3) {
        console.log('[e2e-host] PostgreSQL host port wire ready (SSLRequest probe x3)')
        return
      }
    } else {
      consecutive = 0
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('PostgreSQL host port did not answer SSLRequest within 30s')
}

// PLAN-0656 R2 C3: `precheckDevRuntimeConflict` used to hard-fail when 12633 was
// busy, forcing operators to stop the dev stack before every E2E run. Its only
// justification was the shared cargo target's exe lock (BL-221 family), which the
// build isolation above removes — the gate is gone for good (no opt-in switch: a
// premise that is no longer true should not survive as a flag).

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
  // PLAN-0648（Lead 2026-11-04 批准）：state 过期后里面的 PID 会被系统复用给别的栈/
  // 别的 lane 的进程，盲杀 = 越界杀人（当日两次同签名事故）。杀之前必须过 `kill-guard`
  // 身份门（path-in-projectDir / runId-in-cmdline / listening-on-e2e-port 三信号任一），
  // 证明不了就 `refused to kill foreign pid` 跳过——leak 比误杀安全（下次 preflight 的
  // 端口扫描会把残留报出来）。
  const ports = Object.values(state.ports || {})
    .map(Number)
    .filter((port) => Number.isInteger(port))
  for (const name of Object.keys(state.pids || {})) {
    const pid = state.pids[name]
    if (!pid) continue
    const result = await stopPidIfOwned({
      pid,
      name,
      projectDir,
      runId: state.runId || '',
      ports,
      kill: async (target) => {
        if (process.platform === 'win32') {
          await run('taskkill', ['/PID', String(target), '/T', '/F'], { stdio: 'ignore' })
        } else {
          await run('kill', ['-TERM', String(target)], { stdio: 'ignore' })
        }
      },
    })
    if (result.outcome === 'absent') {
      console.log(`[e2e-host] persistent ${name} (pid=${pid}) already gone`)
    }
  }
}

// PLAN-0375 (R1) + PLAN-0680 task-76 (defects 1 & 2): read-only preflight gate.
// Returns false when the run must not start. `allowPorts`/`ownRunId` mark the
// caller's own persistent stack in reuse mode; `--self-pid` marks this process's
// own detached log/pid record.
//
// Defect 1 (2026-11-07, cost the window half an hour): `--jar-mode=auto` promises
// build-then-use, but this gate only looked at `preflight.code !== 0`, and the
// preflight's artifact section reports a stale jar as FAIL. So a **self-healable**
// condition refused the run and the rebuild that would have fixed it was never
// reached — the error read like "the machine is dirty" when it was the gate
// locking itself. The judgement (`lib/e2e-preflight-gate.mjs`) is now: ask the
// artifact section only about the artifact **this run actually boots**, and let
// every non-artifact blocking scope (ports / docker residue / active runs / disk)
// refuse in every mode — a deferrable artifact condition never buys a pass.
//
// Defect 2: `--skip-preflight` used to skip *everything*, disk gate included, and
// left nothing behind but one console line. Now it skips only the non-disk
// sections (`e2e-preflight.mjs --disk-only` still runs) and records the verdict,
// so the run header can prove the disk was never silently ignored.
async function runPreflightGate({ allowPorts = [], ownRunId = '', extraSelfPids = [], cpBootPlan = null, allowResidual = [] } = {}) {
  // Who boots the artifact decides the section, not the `--jar-mode` argument:
  // `auto` can end up in `run` (rebuild failed) and `--jar-mode=run` is only one
  // of the ways to get there (see resolveCpBootPlan()). D-763②: the composition
  // lives in the lib — a reuse run has no boot plan and `reuse` is an *output*
  // of the policy (`externalServer`), never something to feed back in.
  const policy = preflightGatePolicy({ jarMode, externalServer, cpBootPlan })
  if (skipPreflight) return runSkipPreflightDiskGate(policy)
  // task-237（坑 7）：共享 e2e 构建根里的**旧 jar** 会被只读 preflight 直接 refuse
  // （"CP jar 过期"）。`--jar-mode=auto` 的自愈本该在 resolveCpBootPlan 里发生，但 reuse/外部栈
  // 等入口走不到那段 ⇒ 这里在 preflight **之前**补一次同语义动作：stale jar ⇒ 重建；
  // 重建失败 ⇒ 明确 fail-fast（不让它退化成"preflight 拒绝"这种看不出根因的失败）。
  if ((jarMode === 'auto' || jarMode === 'rebuild') && !externalServer) {
    const state = resolveCpJarState(e2eCpTargetDir)
    const identityMismatch = state.sidecar?.state === 'ok' && state.sidecar.identity === false
    const stale = Boolean(state.jar) && (state.newestSource.mtimeMs > state.jar.mtimeMs || identityMismatch)
    if (stale) {
      console.log(`[e2e-host] preflight 前自愈：CP jar ${state.jar.name} 过期 ⇒ 重建（与 --jar-mode=rebuild 同语义）`)
      const rebuild = await run(mvnCommand, ['-q', '-DskipTests', ...e2eCpBuildArgs, 'package'], {
        cwd: join(projectDir, 'packages', 'control-plane'),
        stdio: 'inherit',
      })
      if (rebuild.code !== 0) {
        console.error(`[e2e-host] FAIL-FAST: CP jar 重建失败 (exit=${rebuild.code})；拒绝继续（否则 preflight 只会报"过期"）`)
        process.exit(1)
      }
      const head = gitHead({ cwd: projectDir })
      if (head.commit) writeBuildInfo({ targetDir: e2eCpTargetDir, commit: head.commit, dirty: head.dirty })
      console.log(`[e2e-host] preflight 前自愈完成：jar 已重建${head.commit ? ` 并盖章 ${head.commit.slice(0, 12)}` : ''}`)
    }
  }
  console.log(`[e2e-host] preflight (read-only): node scripts/e2e-preflight.mjs${policy.ignoreBuild ? ' --ignore-build' : ''}`)
  const selfPids = [process.pid, ...extraSelfPids.filter((pid) => Number.isInteger(pid) && pid > 0)]
  const preflightArgs = [join(projectDir, 'scripts', 'e2e-preflight.mjs'), `--self-pid=${selfPids.join(',')}`]
  if (policy.ignoreBuild) preflightArgs.push('--ignore-build')
  if (allowPorts.length > 0) preflightArgs.push(`--allow-ports=${allowPorts.join(',')}`)
  if (ownRunId) preflightArgs.push(`--own-run-id=${ownRunId}`)
  if (allowResidual.length > 0) {
    // task-238: audited exemption — the names are logged here and in the preflight output, so
    // the run record proves which kept resources were deliberately tolerated.
    console.log(`[e2e-host] preflight residual allowance (--allow-residual): ${allowResidual.join(', ')}`)
    preflightArgs.push(`--allow-residual=${allowResidual.join(',')}`)
  }
  const preflight = await runCapture(nodeCommand, preflightArgs)
  if (preflight.stdout) process.stdout.write(preflight.stdout)
  if (preflight.stderr) process.stderr.write(preflight.stderr)
  // A non-zero exit whose FAIL lines we cannot attribute to a scope must NOT be
  // read as "probably just the artifact section". That fail-closed rule lives in
  // the lib (evaluateGateFindings) so every caller gets it, not just this one.
  const parsedScopes = parseBlockingScopes(preflight.stdout)
  const decision = evaluateGateFindings({ policy, blockingScopes: parsedScopes, preflightExitCode: preflight.code })
  preflightRecord = {
    gate: {
      verdict: decision.verdict,
      buildSection: policy.buildSection,
      cpEntry: policy.cpBootMode,
      deferred: decision.deferred,
      blockingScopes: parsedScopes.length > 0 ? parsedScopes : decision.refusals,
      reason: decision.reason,
      policyReason: policy.reason,
      skippedByFlag: false,
    },
    diskGate: diskGateRecord({ exitCode: preflight.code, diskResult: parseDiskLine(preflight.stdout) }),
  }
  console.log(`[e2e-host] ${describePreflightGate({ ...policy, ...decision })}`)
  if (decision.verdict === 'refuse') {
    console.error('[e2e-host] preflight reported blocking findings; not starting a run.')
    console.error(`[e2e-host] gate verdict: refuse — ${decision.reason}`)
    console.error('[e2e-host] handle the findings above (teardown residue / ports / active run), then retry.')
    if (decision.deferred.length > 0) {
      console.error(`[e2e-host] the artifact section was already deferred to the rebuild path (${decision.deferred.join(', ')}), so these findings are not self-healable.`)
    }
    console.error('[e2e-host] --skip-preflight still runs the disk gate and records it in the run header (use only when you know the finding is not yours).')
    return false
  }
  return true
}

// Defect 2: `--skip-preflight` = skip the non-disk checks, keep the disk gate.
// Three outcomes, all visible: disk ok/skipped ⇒ proceed (recorded `enforced`),
// disk blocked/unverifiable ⇒ refuse, disk segment itself unusable ⇒ proceed but
// record `bypassed` (the only remaining "skip", and it is written down).
async function runSkipPreflightDiskGate(policy) {
  console.log('[e2e-host] --skip-preflight set; skipping the docker/port/artifact/run checks (they are NOT recorded as passed)')
  console.log('[e2e-host] disk gate still runs: node scripts/e2e-preflight.mjs --disk-only')
  const diskRun = await runCapture(nodeCommand, [join(projectDir, 'scripts', 'e2e-preflight.mjs'), '--disk-only'])
  if (diskRun.stdout) process.stdout.write(diskRun.stdout)
  if (diskRun.stderr) process.stderr.write(diskRun.stderr)
  const decision = decideSkipPreflightDisk({ exitCode: diskRun.code, diskResult: parseDiskLine(diskRun.stdout) })
  preflightRecord = {
    gate: {
      verdict: decision.proceed ? 'proceed' : 'refuse',
      buildSection: policy.buildSection,
      cpEntry: policy.cpBootMode,
      deferred: decision.proceed ? ['docker', 'ports', 'build', 'runs', 'digest'] : [],
      blockingScopes: decision.proceed ? [] : ['disk'],
      reason: decision.reason ?? 'skipped by --skip-preflight (disk gate still enforced)',
      policyReason: policy.reason,
      skippedByFlag: true,
    },
    diskGate: decision.record,
  }
  console.log(`[e2e-host] ${describeDiskGate(decision.record)} (recorded as diskGate in the run header)`)
  if (decision.record.mode === 'bypassed') {
    console.warn('[e2e-host] WARNING: neither the preflight nor its disk segment produced a verdict; recording diskGate: bypassed')
  }
  if (!decision.proceed) {
    console.error(`[e2e-host] REFUSE: ${decision.reason}`)
    console.error('[e2e-host] --skip-preflight does not skip the disk gate; free space first (or fix disk sampling) and retry.')
    return false
  }
  return true
}

/**
 * PLAN-0664 (BL-267): the three CLI traps are decided here — after `--help`/`--list-batches`/
 * `--teardown` are handled, and **before** any build, port, container or process work. Nothing in
 * this function derives ports, creates directories or starts child processes, so `--check-cli`
 * (print the plan and exit) can never boot part of a stack.
 *
 * Returns false when the caller must stop (refusal, strict-mode escalation or `--check-cli`);
 * the exit code has already been set on `process.exitCode`.
 */
function runCliPreflight() {
  const strictCli = process.env.XIHE_E2E_CLI_STRICT === '1'
  const stop = (exitCode = 2) => {
    process.exitCode = exitCode
    return false
  }

  const llmDecision = decideLlmMode({
    batchName,
    batchLlmMode: batch?.llmMode,
    argMode: llmModeArg?.slice('--llm-mode='.length),
    envMode: process.env.XIHE_E2E_LLM_MODE,
    allowOverride: allowLlmModeOverride,
  })
  if (llmDecision.action === 'refuse') {
    console.error(`[e2e-host] REFUSE ${llmDecision.message}`)
    return stop()
  }

  const issues = []
  if (llmDecision.action === 'warn') issues.push(llmDecision.message)
  const batchWarning = warnBatchPlusSpecs({ batchName, batchSpecs, positionalSpecs })
  if (batchWarning.action === 'warn') issues.push(batchWarning.message)
  const retryWarning = decideRetrySemantics({
    retriesArg: retriesArgValue,
    retryRoundsEnv: process.env.XIHE_E2E_RETRY_ROUNDS,
  })
  if (retryWarning.action === 'warn') issues.push(retryWarning.message)

  for (const message of issues) {
    if (strictCli) {
      console.error(`[e2e-host] REFUSE (XIHE_E2E_CLI_STRICT=1) ${message}`)
      return stop()
    }
    console.warn(`[e2e-host] WARN ${message}`)
  }

  if (checkCli) {
    console.log(`[e2e-host] check-cli (no process, port or directory is created by this mode)`)
    console.log(`[e2e-host] check-cli: ${formatCheckCliSummary({
      batchName,
      llmMode,
      specs: batchSpecs,
      positionalSpecs,
    })}`)
    if (issues.length > 0) {
      console.log(`[e2e-host] check-cli: ${issues.length} warning(s) above; exit 0 (warnings are non-blocking unless XIHE_E2E_CLI_STRICT=1)`)
    }
    return stop(0)
  }
  return true
}

async function main() {
  if (checkpointSaverProbeRequested && (externalServer || isPersistent)) {
    throw new Error('checkpoint saver probe requires an owned, non-persistent exact-spec host run')
  }
  if (checkpointResumeRequested && (
    externalServer || isPersistent || realXiaomiKey || llmMode !== 'checkpoint_resume'
  )) {
    throw new Error('checkpoint resume probe requires its owned offline fake-LLM exact-spec lane')
  }
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
  // PLAN-0664 (BL-267): CLI traps are decided before any artifact/port/container work, and
  // `--check-cli` stops here (nothing below this line has run yet).
  if (!runCliPreflight()) return
  // task-86: `--plan-only` dry-runs the *owned* boot sequence; a reuse run boots nothing of its own,
  // so there is no rebuild phase to order against (and the defect shape cannot exist there).
  if (planOnly && externalServer) {
    throw new Error('--plan-only dry-runs the owned boot sequence; a reuse run (XIHE_E2E_EXTERNAL_SERVER=1) has no rebuild phase')
  }
  // task-86: the phase order is `lib/e2e-host-boot-phases.mjs`; main() only consumes it. Wrong order
  // ⇒ BootPhaseOrderError before anything is built, instead of a silent regression.
  const bootPhases = createBootPhaseCursor({ plan: bootPhasePlan({ externalServer }) })
  if (jarMode === 'native' && skipRuntime) {
    throw new Error('--jar-mode=native requires Runtime; remove --skip-runtime to test the native compatibility lane')
  }
  if (externalServer && jarMode === 'native') {
    throw new Error('--jar-mode=native owns the isolated stack and cannot be combined with XIHE_E2E_EXTERNAL_SERVER=1')
  }
  // PLAN-0375 (R2): repair the artifact condition the runner owns *before* the
  // read-only preflight runs — preflight fails on a stale CP jar, so a
  // preflight-first order would make the rebuild unreachable.
  let cpBootPlan = null
  if (!externalServer) {
    bootPhases.enter(BOOT_PHASE.CP_BOOT_PLAN)
    // task-86: `--plan-only` must not run `mvn` — it reads the same jar state and asks the same
    // `decideCpBoot()` table, so the operator still sees which artifact a real run would boot.
    cpBootPlan = planOnly ? previewCpBootPlan() : await resolveCpBootPlan()
    const cpBootCommand = cpBootPlan.mode === 'jar'
      ? `java -jar ${cpBootPlan.jar.name}`
      : cpBootPlan.mode === 'native'
        ? cpBootPlan.executable.name
        : 'mvn spring-boot:run'
    console.log(`[e2e-host] CP boot: ${cpBootCommand} (${cpBootPlan.reason})`)
  }
  console.log(`[e2e-host] runId=${e2eRunId} ports ui=${uiPort} cp=${cpPort} agent=${agentPort} runtime=${runtimePort} pg=${pgPort}`)
  console.log(`[e2e-host] isolated pg project=${pgProjectName} db=${pgDatabase} hostRoot=${hostRoot}`)
  if (skipRuntime) console.log('[e2e-host] --skip-runtime set; this run validates chat-only paths without Sandbox execution')
  // task-86: `--plan-only` must not delete anything — pruning stale run dirs is a real side effect.
  if (!planOnly) await pruneStaleRunDirs()

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
        // Reuse specs authenticate against the running stack, so the service
        // Bearer must stay the recorded one; without this the external run
        // signs with a fresh token and every service-authed call is a 401.
        if (state.serviceToken) serviceToken = state.serviceToken
        // D4: reuse-mode logins (configureFakeLlm, UI fixtures) must present the
        // stack's admin password, not this process's fresh random one.
        if (state.adminPassword) e2eAdminPassword = state.adminPassword
        if (state.registrationPolicy) registrationPolicy = state.registrationPolicy
        runIdForTests = state.runId
    // PLAN-0465: PG fixture 元数据同样由栈 runId 派生——端口/fixture 已恢复
    // （PLAN-0365 root cause A）但 pg project/DB 名仍取本进程 runId，导致
    // reuse 模式下 docker exec 指向不存在的容器（session-branch 授权种子、
    // plan0366 S5 域表断言都会命中此坑）。
    if (state.pgProjectName) pgProjectName = state.pgProjectName
    pgDatabase = `xihe_e2e_${state.runId.replace(/[^a-z0-9]/gi, '_')}`
    reuseOwnPorts = [uiPort, cpPort, agentPort, runtimePort, pgPort, fakeOAuthPort, fakeMcpPort, fakeLlmPort]
    reuseOwnRunId = state.runId
    console.log(`[e2e-host] persistent stack ${state.runId}: ui=${uiPort} cp=${cpPort} agent=${agentPort} runtime=${runtimePort}`)
    // 关键：本进程新生成的 e2eRunId 与栈不同，传给 Playwright 的必须是栈 runId
    // （隔离库名与 host root 都由它派生）。两者都打印，避免操作者误判。
    console.log(`[e2e-host] reuse: 传给 Playwright 的 XIHE_E2E_RUN_ID=${runIdForTests}（本次进程 runId=${e2eRunId} 仅用于日志）`)
  } else if (externalServer) {
    // PLAN-0662 L5 (+ BL-253 L3): an external stack is exactly the case where "which commit is CP
    // actually running" is invisible — and where a stale build manufactures fake product bugs
    // (BL-240: a 20:01 build was read as `develop` 11 merges later). Assert before any spec runs.
    //
    // Which directory to check: with per-stack build dirs, "from env" is a guess. Ask the stack
    // record instead — `XIHE_STACK_ID` → that stack's `.current` pointer (last start), then the
    // newest build slot, then the computed path. It is still a record on disk, not JVM
    // introspection; the log line names the source so the operator can see what was checked.
    // Expected commit: XIHE_E2E_EXPECT_CP_COMMIT when declared, else this checkout's HEAD.
    // A **missing** stamp fails too — an unstamped CP must not slip through this gate.
    const externalStackId = (process.env.XIHE_STACK_ID ?? '').trim()
    const cpBuildRootDir = cpBuildRoot({ env: process.env })
    const headInfo = gitHead({ cwd: projectDir })
    const target = externalStackId
      ? resolveBuildTargetForStack({
          root: cpBuildRootDir,
          stackId: externalStackId,
          env: process.env,
          commit: headInfo.commit,
          dirty: headInfo.dirty,
        })
      : {
          targetDir: cpTargetDir({ projectRoot: projectDir, env: process.env }),
          source: 'env',
        }
    console.log(
      `[e2e-host] CP build dir check: ${target.targetDir} source=${target.source}`
      + (externalStackId ? ` stack=${externalStackId}` : ' (no XIHE_STACK_ID: env-derived path)'),
    )
    const cpBuildCheck = externalCpBuildCheck({
      targetDir: target.targetDir,
      expectedCommit: process.env.XIHE_E2E_EXPECT_CP_COMMIT,
      headCommit: headInfo.commit,
    })
    if (!cpBuildCheck.ok) {
      console.error(`[e2e-host] CP build check FAILED (${cpBuildCheck.verdict}): ${cpBuildCheck.message}`)
      process.exitCode = 1
      return
    }
    console.log(`[e2e-host] ${cpBuildCheck.message}`)
    console.log('[e2e-host] XIHE_E2E_EXTERNAL_SERVER=1 set; assuming services are already running externally')
  }

  // PLAN-0375 (R1) + PLAN-0680 task-76: open the window with the read-only
  // preflight. It runs after `resolveCpBootPlan()` (so the artifact section asks
  // about the artifact this run boots, and a stale jar was already rebuilt) and
  // after the reuse restore (so the caller's own persistent stack — ports and
  // sandbox labels — is recognised instead of being reported as leaked residue).
  // task-86: THIS enter() and the `CP_BOOT_PLAN` one above are the wiring the old unit tests only
  // *simulated*. The order comes from `lib/e2e-host-boot-phases.mjs`; moving either step without
  // moving the plan throws `BootPhaseOrderError` here — before a rebuild, a port or a container.
  bootPhases.enter(BOOT_PHASE.PREFLIGHT_GATE)
  if (planOnly) {
    // `--plan-only` exits here: the two real phase entries above have run, everything heavy was
    // short-circuited. `ok` compares executed against declared — drift cannot pass this line.
    const trace = bootPhases.describe()
    console.log(`[e2e-host] plan-only: declared=${trace.declared.join(',')} executed=${trace.executed.join(',')} ok=${trace.ok}`)
    console.log(`[e2e-host] plan-only json: ${JSON.stringify(trace)}`)
    if (!trace.ok) {
      console.error(`[e2e-host] plan-only: boot phase order is NOT the declared plan (missing=${trace.missing.join(',') || 'none'})`)
      process.exitCode = 1
    }
    return
  }
  if (!(await runPreflightGate({ allowPorts: reuseOwnPorts, ownRunId: reuseOwnRunId, extraSelfPids: [reuseRunnerPid], cpBootPlan, allowResidual: allowResidualNames }))) {
    process.exitCode = 1
    return
  }

  if (externalServer) {
    // reuse path: the persistent stack is already up, skip all boot phases.
    // PLAN-0365 (root cause E): the LLM provider config is imported at boot
    // time from --llm-mode; restore it here so external spec runs can use a
    // different mode than the boot run. PLAN-0504: every lane (mock included)
    // imports its profile — the mock lane is no longer implicitly ready.
    if (!process.env.XIHE_E2E_SKIP_FIXTURES) {
      if (llmMode !== 'mock') {
        // PLAN-0365 (root cause E) + D4: a persistent stack already owns some
        // or all of the fixtures. Probe every fixture and start only the
        // missing ones — re-spawning the running OAuth/MCP pair hits
        // EADDRINUSE on the reused ports and aborts the run before Playwright
        // ever starts.
        const fixtures = describeFixtures()
        const missing = []
        for (const fixture of fixtures) {
          if (!(await fixtureAlive(fixture.port))) missing.push(fixture.name)
        }
        if (missing.length > 0) {
          console.log(`[e2e-host] reuse: starting missing fixture(s) ${missing.join(', ')}`)
          await startFixtures(missing)
        }
      }
      await configureFakeLlm()
    }
  } else {
  // PLAN-294 F.5 L1+L2: parallel boot orchestration. Fixtures and PostgreSQL
  // run concurrently; then all four services launch together (Agent's config
  // sync self-heals via periodic re-poll when CP is not ready yet; the chat
  // path's LLM readiness gate covers the remaining window). CP prefers the
  // pre-built fat jar (skips ~20s of Maven lifecycle per boot).
    const cpDatasource = `jdbc:postgresql://localhost:${pgPort}/${pgDatabase}`
    const useCpNative = cpBootPlan?.mode === 'native'
    const useCpJar = cpBootPlan?.mode === 'jar'
    const cpJar = useCpJar ? cpBootPlan.jar.path : null
    const cpNativeExecutable = useCpNative ? cpBootPlan.executable.path : null
    const commonCpEnv = {
      XIHE_CP_PORT: cpPort,
      XIHE_CP_DATASOURCE_URL: cpDatasource,
      XIHE_PG_PORT: pgPort,
      XIHE_CP_DATASOURCE_USERNAME: pgUser,
      XIHE_CP_DATASOURCE_PASSWORD: pgPassword,
      XIHE_CP_JWT_SECRET: `e2e-${e2eRunId}-jwt-secret`,
      XIHE_AGENT_URL: `http://127.0.0.1:${agentPort}/internal/v1/agent/chat`,
      XIHE_AGENT_BASE_URL: `http://127.0.0.1:${agentPort}`,
      XIHE_RUNTIME_URL: `http://127.0.0.1:${runtimePort}`,
      XIHE_DEV_ADMIN_PASSWORD: e2eAdminPassword,
      XIHE_AUTH_REGISTRATION_POLICY: registrationPolicy,
      // PLAN-0612 M4: the host E2E lane is the single documented exemption from the
      // frozen workspace docker backend; inject it explicitly instead of relying on a
      // developer's shell env.
      XIHE_WORKSPACE_DOCKER_BACKEND: 'disabled',
      // PLAN-0611 (Lead ruling D): the CP↔Runtime WebSocket channel is a readiness concern in every
      // boot mode, not a native-image nicety. `xihe.channel.enabled` defaults to false in
      // application.properties, so without this env a non-native boot silently stays on HTTP
      // heartbeats and the CP's runtime circuit breaker opens
      // (`event=circuitBreakerOpen service=runtime failureCount=…`); chat runs then fail with no
      // chat-side error line to look at.
      XIHE_CHANNEL_ENABLED: 'true',
    }
    if (useCpJar) console.log(`[e2e-host] CP boot via fat jar ${cpBootPlan.jar.name} (${cpBootPlan.reason})`)
    else if (useCpNative) console.log(`[e2e-host] CP boot via native executable ${cpBootPlan.executable.name} (${cpBootPlan.reason})`)
    else console.log(`[e2e-host] CP boot via mvn spring-boot:run (${cpBootPlan?.reason ?? 'external decision'})`)

    // PLAN-0650 M5 (T5.3/T5.4): the criterion compares a second round against the first, so both
    // numbers have to be on the record. `boot` is the whole stack; each retry logs its own reset.
    const bootBegan = Date.now()

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
        await waitForPostgresWireReady()
        if (useCpNative) {
          await launchNativeService({
            name: 'control-plane',
            cmd: cpNativeExecutable,
            // Keep the native runtime graph aligned with the Spring profile used by process-aot.
            args: ['--spring.profiles.active=native-aot'],
            cwd: join(projectDir, 'packages', 'control-plane'),
            extraEnv: { ...commonCpEnv, XIHE_CP_PORT: cpPort, XIHE_LOAD_DOTENV: '0', XIHE_LOG_DIR: e2eLogDir },
            healthUrl: `http://127.0.0.1:${cpPort}/actuator/health`,
          })
          await configureFakeLlm()
        } else if (!useCpJar) {
          await launchNativeService({
            name: 'control-plane',
            cmd: 'mvn.cmd',
            args: ['-q', '-DskipTests', ...e2eCpBuildArgs, '-Dspring-boot.run.profiles=e2e', 'spring-boot:run'],
            cwd: join(projectDir, 'packages', 'control-plane'),
            extraEnv: { ...commonCpEnv, XIHE_CP_PORT: cpPort, XIHE_LOG_DIR: e2eLogDir },
            healthUrl: `http://127.0.0.1:${cpPort}/actuator/health`,
          })
          await configureFakeLlm()
        } else {
          await launchNativeService({
            name: 'control-plane',
            cmd: 'java',
            args: ['-jar', cpJar, '--spring.profiles.active=e2e'],
            cwd: join(projectDir, 'packages', 'control-plane'),
            extraEnv: { ...commonCpEnv, XIHE_CP_PORT: cpPort, XIHE_LOG_DIR: e2eLogDir },
            healthUrl: `http://127.0.0.1:${cpPort}/actuator/health`,
          })
          await configureFakeLlm()
        }
      })(),
      (async () => {
        // The Agent's startup config sync only retries ~3 attempts over a
        // couple of seconds before marking startup_sync_failed; under
        // `mvn spring-boot:run` CP routinely needs 15–30 s (Flyway + devtools),
        // so launching the Agent concurrently makes the race lose almost every
        // time on a loaded machine (2026-11-03 headed runs failed twice on
        // `ConfigClient: required effective refresh failed statuses=['unreachable']`).
        // Production ordering (launcher) always starts CP before the Agent, so
        // gate the Agent on CP health here too — "config sync self-heals" only
        // covers first-request laziness, not the startup health probe the lane
        // asserts against.
        await waitForHttp('cp-before-agent', `http://127.0.0.1:${cpPort}/actuator/health`, readinessTimeoutMs, {})
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
            // PLAN-0307 decision #21/#37 (BYOK): fake/real credentials travel
            // through the Agent env fallback, never through config layers.
            // PLAN-0650 B-1: provider / provider key / XIHE_API_BASE come from the
            // same `lib/llm-env.mjs` the restart contract uses — no second copy to
            // drift (real lanes pin the endpoint on both routes, see that module).
            ...llmEnv({
              realKey: realXiaomiKey,
              realRoute,
              llmMode,
              fakeLlmPort,
              realApiBase: process.env.XIHE_E2E_REAL_API_BASE,
            }),
          },
          healthUrl: `http://127.0.0.1:${agentPort}/internal/v1/agent/health`,
        })
        // F.5: under parallel boot the Agent starts before CP/fake-config is
        // ready; its config sync then 401s and the next re-poll is 30s away.
        // Playwright must not start until the agent actually reports
        // llmReady=ready, or the first chat 503s out of the send window.
        // PLAN-0504: `missing` intentionally has no profile and stays
        // not-ready (LLM_NOT_CONFIGURED) — that lane must not burn the full
        // readiness budget waiting for a state it will never reach.
        // PLAN-0525 (decision #9): the wait is fail-closed — exhausting the
        // budget now aborts the run instead of falling through to Playwright,
        // where it used to surface as an opaque 30s `beforeAll` timeout.
        const expectNotReady = llmMode === 'missing'
        await waitForAgentLlmReady({
          healthUrl: `http://127.0.0.1:${agentPort}/internal/v1/agent/health`,
          expectReady: !expectNotReady,
          timeoutMs: readinessTimeoutMs,
        })
      })(),
      ...(skipRuntime ? [] : [(async () => {
        const runtimeProcess = await launchNativeService({
          name: 'runtime',
          cmd: 'cargo',
          args: ['run', '--bin', 'xihe-runtime'],
          cwd: join(projectDir, 'packages', 'runtime'),
          extraEnv: {
            XIHE_RUNTIME_PORT: runtimePort,
            XIHE_CP_URL: `http://127.0.0.1:${cpPort}`,
            XIHE_WORKSPACE_IMAGE: 'xihe/workspace:latest',
            // Lead ruling D: the outbound channel URL is not native-only. Without it
            // `runtime/src/channel.rs` falls back to HTTP heartbeat and the CP breaker opens.
            XIHE_CHANNEL_URL: `http://127.0.0.1:${cpPort}`,
            ...(process.env.CARGO_TARGET_DIR ? { CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR } : {}),
          },
          healthUrl: `http://127.0.0.1:${runtimePort}/health`,
        })
        await waitForHttp('Runtime readiness', `http://127.0.0.1:${runtimePort}/ready`)
        // Lead ruling D: gate every boot mode on the channel handshake, not just the native one.
        // A silent breaker is exactly what hid the G2-e failure, so a timeout must name the CP-side
        // breaker state instead of only saying "channel not confirmed".
        await waitForRuntimeChannelHandshake(runtimeProcess).catch(async (error) => {
          throw await channelHandshakeFailure(error)
        })
      })()]),
      launchUIVite(),
    ]
    // task-237: boot 整体带 deadline —— 任何子任务卡住都要在有限时间内失败退出，而不是无限等。
    await Promise.race([
      Promise.all(bootTasks),
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error(`stack boot exceeded ${BOOT_TIMEOUT_MS}ms (task-237 fail-fast)`)),
          BOOT_TIMEOUT_MS,
        ).unref?.()
      }),
    ])
    const bootElapsedMs = Date.now() - bootBegan
    stackBootElapsedMs = bootElapsedMs
    console.log(`[e2e-host] stack boot completed in ${(bootElapsedMs / 1000).toFixed(2)}s (baseline for the round-retry ratio)`)
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
      // D4: reuse-mode runs must authenticate against the stack that is already
      // up; the dev admin password is regenerated per process otherwise.
      adminPassword: e2eAdminPassword,
      registrationPolicy,
      // PLAN-0680 task-76: the boot-only lane is where a skipped disk gate used to
      // vanish entirely; reuse runs inherit this file, so the verdict must round-trip.
      preflight: preflightRecord,
    }, null, 2))
    console.log(`[e2e-host] persistent stack ready; state written to ${stateFile}`)
    if (preflightRecord?.diskGate) console.log(`[e2e-host] recorded ${describeDiskGate(preflightRecord.diskGate)} in ${stateFile}`)
    console.log('[e2e-host] run specs with: XIHE_E2E_EXTERNAL_SERVER=1 node scripts/e2e-host.mjs --llm-mode=<mode> <specs...>')
    console.log('[e2e-host] stop it with: node scripts/e2e-host.mjs --teardown')
    process.exitCode = 0
    return
  }
  await writeArtifactsManifest(cpBootPlan)
  if (exactCheckpointHostProbeRequested) await startCheckpointProbeControl()
  // PLAN-0650 M5: retries are in-process by default. A failed round resets the data plane and
  // replays, instead of tearing the stack down and paying the whole boot again (BL-205 ③).
  const retryPolicy = decideRetryRounds({
    rounds: process.env.XIHE_E2E_RETRY_ROUNDS,
    rebuildOnRetry: process.env.XIHE_E2E_REBUILD_ON_RETRY === '1',
    // The reuse lane (XIHE_E2E_EXTERNAL_SERVER=1) runs against a stack it does not own: resetting
    // it would silently destroy another run's state.
    stackOwned: !externalServer,
  })
  const resetChoice = chooseRoundResetStrategy({ requested: process.env.XIHE_E2E_ROUND_RESET })
  console.log(`[e2e-host] rounds: ${retryPolicy.rounds} — ${retryPolicy.reason}`)
  console.log(`[e2e-host] between-round reset: ${resetChoice.strategy} — ${resetChoice.reason}`)
  // Captured before the first spec runs: those tables are the stack's own seed state and must
  // survive a `truncate` reset (see lib/e2e-rounds.mjs#selectTablesToTruncate). The reuse lane is
  // excluded on purpose — its PG container belongs to the run that created the stack, not to this
  // process's `pgProjectName`, and that lane never resets anything anyway (rounds = 1).
  seedTablesSnapshot = externalServer ? [] : await captureSeedTables()
  const baseRunIdForTests = runIdForTests
  for (let round = 1; round <= retryPolicy.rounds; round += 1) {
    if (round > 1) {
      const reset = await resetRoundState({ round, strategy: resetChoice.strategy })
      if (!reset.ok) {
        // Fail closed: no retry with unknown stack state. The previous round's exit code stands.
        console.error('[e2e-host] in-process retry abandoned; keeping the failed round result')
        break
      }
    }
    // A fresh id per round is what makes round N unable to see round N-1's host-root artifacts.
    runIdForTests = roundRunId(baseRunIdForTests, round)
    if (retryPolicy.rounds > 1) {
      console.log(`[e2e-host] round ${round}/${retryPolicy.rounds}: XIHE_E2E_RUN_ID=${runIdForTests}`)
    }
    lifecyclePhase = 'tests'
  result = await runPlaywright()
    if (result.code === 0) break
    if (round < retryPolicy.rounds) {
      console.warn(`[e2e-host] round ${round}/${retryPolicy.rounds} failed (exit=${result.code}); resetting state and retrying in-process`)
    }
  }
  // PLAN-0650 M5 (T5.4): print the number the acceptance criterion is about, and say plainly when
  // it is missed — a warm-start claim that is never measured is exactly what M5 replaced.
  if (lastRoundResetMs !== null && stackBootElapsedMs) {
    const ratio = lastRoundResetMs / stackBootElapsedMs;
    const line = `warm-start: round-2 reset ${(lastRoundResetMs / 1000).toFixed(2)}s vs round-1 boot `
      + `${(stackBootElapsedMs / 1000).toFixed(2)}s → ${(ratio * 100).toFixed(1)}% (criterion: <= 50%)`;
    console.log(`[e2e-host] ${line}`);
    if (ratio > 0.5) {
      console.warn('[e2e-host] warm-start criterion NOT met for this run; record the two numbers in verify.md V10');
    }
  }
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
  // PLAN-0656 R2 C4: E2E no longer stops or disturbs the dev stacks (build
  // isolation), so the old "dev runtime was stopped for this run" reminder is gone.
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
  // task-237: 以前这里是 `await cleanup()` 无上限 —— 任一步卡住（compose down / waitForChildExit）
  // 就是"父进程永远活着、fake server 还占端口"。现在 cleanup 带 deadline，超时即强杀并 exit。
  await cleanupWithDeadline('main() failed', 1)
})
