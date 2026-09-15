#!/usr/bin/env node
/**
 * PLAN-0328 M3 (T2.9) — Run-checkpoint resource & performance probe against a REAL Runtime.
 *
 * Measures, on a purpose-built fixture workspace (default 10k files + ignored / oversized /
 * credential / generated candidates):
 *   - establish/base and seal durations (median + P95 over --runs repetitions);
 *   - exclusion hit rate plus per-category verification (ignored / large / credential / generated
 *     paths must NOT appear in the seal change set);
 *   - shadow-storage deltas: first run (whole tree) vs incremental runs (no changes);
 *   - revert wall + Runtime-reported duration for change sets of 1 and 100 files, twice each
 *     (cold = first execution for that size in this process, warm = a second same-shaped run).
 *
 * Design constraints:
 *   - NEVER deletes anything. The fixture workspace and its shadow repository are left in place
 *     (the e2e host root is recycled by scripts/e2e-host.mjs teardown; a dev host root is the
 *     operator's call). Refuses to reuse a non-empty fixture directory or an existing shadow.
 *   - Zero dependencies (Node 24+, global fetch). Only talks to the Runtime internal API; it
 *     never touches CP, Docker, or the sandbox.
 *   - The Runtime must already have `XIHE_WORKSPACE_HOST_ROOT` pointing at --host-root; the
 *     diagnostics `checkpoint.shadowRoot` is cross-checked so a mismatch fails fast instead of
 *     measuring the wrong directory.
 *
 * Flags (all optional):
 *   --base-url=<url>       Runtime base URL (default http://127.0.0.1:12633)
 *   --host-root=<dir>      Runtime XIHE_WORKSPACE_HOST_ROOT (default $XIHE_WORKSPACE_HOST_ROOT
 *                          or <repo>/.xihe-workspaces)
 *   --token=<bearer>       Runtime service token (default $XIHE_CP_API_TOKEN, else the Runtime's
 *                          dev fallback `dev-token-not-secure`)
 *   --workspace=<id>       Fixture workspace id (default budget-<utcstamp>-<rand>; must match
 *                          ^[A-Za-z0-9_-]{1,64}$)
 *   --files=<n>            Regular fixture files (default 10000)
 *   --runs=<n>             Establish/seal repetitions for median+P95 (default 5)
 *   --revert-files=<a,b>   Revert change-set sizes (default 1,100)
 *   --timeout-ms=<ms>      Per-request timeout, establish/seal get 2x (default 120000)
 *   --out=<path>           Also write the report: `.json` path writes JSON, `.md` writes the
 *                          markdown table, any other extension writes JSON.
 *   --help                 Print this header.
 *
 * Usage (against the isolated host stack of scripts/e2e-host.mjs, persisted with --persistent):
 *   node scripts/checkpoint-budget.mjs --host-root=.tmp/e2e-host/<run-id> \
 *     --base-url=http://127.0.0.1:<runtime-port> --token=<XIHE_CP_API_TOKEN> --out=.local/evidence/checkpoint-budget.json
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

const projectDir = dirname(import.meta.dirname)

// ── argv ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  const header = await readFile(new URL(import.meta.url), 'utf8')
  const comment = header.match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? ''
  console.log(comment.replace(/^ \* ?/gm, '').trim())
  process.exit(0)
}

function argValue(name) {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : undefined
}

const baseUrl = (argValue('base-url') ?? process.env.XIHE_BUDGET_BASE_URL ?? 'http://127.0.0.1:12633').replace(/\/+$/, '')
const hostRoot = resolve(argValue('host-root') ?? process.env.XIHE_WORKSPACE_HOST_ROOT ?? join(projectDir, '.xihe-workspaces'))
const token = argValue('token') ?? process.env.XIHE_CP_API_TOKEN ?? 'dev-token-not-secure'
const fileCount = Number(argValue('files') ?? '10000')
const runCount = Number(argValue('runs') ?? '5')
const revertSizes = (argValue('revert-files') ?? '1,100')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)
const timeoutMs = Number(argValue('timeout-ms') ?? '120000')
const outPath = argValue('out')
const workspaceId = argValue('workspace') ?? `budget-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`

for (const [name, value] of Object.entries({ fileCount, runCount, timeoutMs })) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`)
  }
}
if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) {
  throw new Error(`--workspace must match ^[A-Za-z0-9_-]{1,64}$ (Runtime storage-ref contract), got ${workspaceId}`)
}
if (revertSizes.length === 0) {
  throw new Error('--revert-files must contain at least one positive integer')
}

// Frozen V17 / design §5.1 budgets (indicative; the markdown table flags pass/fail).
const BUDGET = {
  establishMedianMs: 2000,
  establishP95Ms: 8000,
  sealMedianMs: 2000,
  sealP95Ms: 8000,
  revertPerFileMs: 50,
  revert100FilesMs: 5000,
  storageRatio: 1.5,
}

// ── tiny helpers ────────────────────────────────────────────────────────────

const workspaceDir = join(hostRoot, workspaceId)
const shadowDir = join(hostRoot, '.xihe-shadow', `${workspaceId}.git`)

function log(message) {
  console.log(`[budget] ${message}`)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isNonEmptyDir(path) {
  try {
    const entries = await readdir(path)
    return entries.length > 0
  } catch {
    return false
  }
}

async function dirBytes(path) {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      total += await dirBytes(child)
    } else if (entry.isFile()) {
      total += (await stat(child)).size
    }
  }
  return total
}

async function writeFixtureFile(relativePath, content) {
  const absolute = join(workspaceDir, relativePath)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, content)
}

/** Nearest-rank percentile over already-collected millisecond samples. */
function percentile(samples, fraction) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)))
  return Math.round(sorted[rank - 1])
}

function median(samples) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return Math.round(sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2)
}

async function request(method, path, { body, timeout = timeoutMs } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const started = performance.now()
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'X-Request-Id': `checkpoint-budget-${Date.now()}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload = null
    try {
      payload = text ? JSON.parse(text) : null
    } catch {
      payload = text
    }
    return { status: response.status, ok: response.ok, payload, text, elapsedMs: Math.round(performance.now() - started) }
  } finally {
    clearTimeout(timer)
  }
}

async function requestChecked(method, path, options = {}) {
  const result = await request(method, path, options)
  if (!result.ok) {
    throw new Error(`${method} ${path} -> HTTP ${result.status}: ${String(result.text).slice(0, 400)}`)
  }
  return result
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ── probe steps ─────────────────────────────────────────────────────────────

const runIds = []
let runCounter = 0
function nextRunId(label) {
  runCounter += 1
  const runId = `${label}-${Date.now()}-${runCounter}`
  runIds.push(runId)
  return runId
}

async function createBase(runId) {
  const result = await requestChecked('POST', `/internal/v1/runtime/workspaces/${workspaceId}/checkpoints`, {
    body: { runId, actor: 'checkpoint-budget', callId: `budget:${runId}` },
    timeout: timeoutMs * 2,
  })
  assertEqual(result.payload.state, 'base', 'create base state')
  return result
}

async function sealRun(runId) {
  const result = await requestChecked('POST', `/internal/v1/runtime/workspaces/${workspaceId}/checkpoints/${runId}/seal`, {
    timeout: timeoutMs * 2,
  })
  assertEqual(result.payload.state, 'sealed', 'seal state')
  return result
}

async function previewRevert(runId) {
  return requestChecked('POST', `/internal/v1/runtime/workspaces/${workspaceId}/checkpoints/${runId}/revert/preview`)
}

async function executeRevert(runId) {
  return requestChecked('POST', `/internal/v1/runtime/workspaces/${workspaceId}/checkpoints/${runId}/revert`, {
    body: { acknowledgeConflicts: [], acknowledgeHeadChange: false },
  })
}

async function report() {
  // ── health + diagnostics cross-check ──────────────────────────────────────
  const health = await requestChecked('GET', '/health')
  if (health.payload?.status !== 'ok') {
    throw new Error(`Runtime /health is not ok: ${health.text}`)
  }
  const diagnostics = await requestChecked('GET', '/internal/v1/runtime/diagnostics')
  const checkpoint = diagnostics.payload?.checkpoint ?? {}
  if (checkpoint.capable !== true) {
    throw new Error(`Runtime reports checkpoints are not capable (host git unavailable?): ${JSON.stringify(checkpoint)}`)
  }
  const expectedShadowRoot = join(hostRoot, '.xihe-shadow')
  const reportedShadowRoot = resolve(checkpoint.shadowRoot ?? '')
  if (reportedShadowRoot.replaceAll('\\', '/').toLowerCase() !== expectedShadowRoot.replaceAll('\\', '/').toLowerCase()) {
    throw new Error(
      `--host-root mismatch: Runtime checkpoint.shadowRoot=${checkpoint.shadowRoot} but --host-root implies ${expectedShadowRoot}. ` +
      'Pass the XIHE_WORKSPACE_HOST_ROOT the Runtime was started with.',
    )
  }

  // ── fixture guards (never delete, never reuse state) ──────────────────────
  if (await isNonEmptyDir(workspaceDir)) {
    throw new Error(`fixture workspace already exists and is not empty: ${workspaceDir} (refusing to reuse; pick another --workspace)`)
  }
  if (await exists(shadowDir)) {
    throw new Error(`shadow repository already exists: ${shadowDir} (refusing to reuse; pick another --workspace)`)
  }
  await mkdir(workspaceDir, { recursive: true })

  log(`fixture workspace ${workspaceDir}`)
  log(`fixture shadow    ${shadowDir}`)

  // ── phase A: exclusion behaviour + first storage delta ────────────────────
  // Base is established on the empty fixture; the tree is then filled and sealed, so the seal
  // change set is exactly the tracked part of the fixture.
  const exclusionRun = nextRunId('exclude')
  const shadowBytesBefore = await dirBytes(shadowDir)
  const exclusionBase = await createBase(exclusionRun)

  const included = []
  for (let i = 0; i < fileCount; i++) {
    const relative = `src/d${String(i % 100).padStart(2, '0')}/file-${i}.txt`
    await writeFixtureFile(relative, `fixture file ${i}\n`)
    included.push(relative)
  }
  await writeFixtureFile('.gitignore', 'ignored-dir/\n*.log\n')
  included.push('.gitignore')
  const excluded = {
    ignored: ['ignored-dir/secret.log', 'app.log'],
    large: ['large-untracked.bin'],
    credential: ['secrets/deploy.pem', 'secrets/id_rsa', '.npmrc', '.env'],
    generated: ['node_modules/pkg/index.js', 'dist/bundle.js', '.cache/blob.bin', '.tmp/scratch.txt'],
  }
  for (const path of excluded.ignored) {
    await writeFixtureFile(path, `ignored fixture ${path}\n`)
  }
  for (const path of excluded.large) {
    await writeFixtureFile(path, `${'0'.repeat(11 * 1024 * 1024)}`)
  }
  for (const path of excluded.credential) {
    await writeFixtureFile(path, `credential fixture ${path}\n`)
  }
  for (const path of excluded.generated) {
    await writeFixtureFile(path, `generated fixture ${path}\n`)
  }
  const createdPaths = [...included, ...Object.values(excluded).flat()]
  const fixtureBytes = await dirBytes(workspaceDir)

  const exclusionSeal = await sealRun(exclusionRun)
  const changed = (exclusionSeal.payload.changedFiles ?? []).map((file) => file.path)
  const firstRunBytes = (await dirBytes(shadowDir)) - shadowBytesBefore

  const missingIncluded = included.filter((path) => !changed.includes(path))
  if (missingIncluded.length > 0) {
    throw new Error(`seal change set is missing expected tracked files (first 5): ${missingIncluded.slice(0, 5).join(', ')}`)
  }
  for (const [category, paths] of Object.entries(excluded)) {
    const leaked = paths.filter((path) => changed.includes(path))
    if (leaked.length > 0) {
      throw new Error(`excluded category "${category}" leaked into the change set: ${leaked.join(', ')}`)
    }
  }

  const exclusion = {
    candidates: createdPaths.length,
    included: changed.length,
    excluded: createdPaths.length - changed.length,
    hitRate: Number(((createdPaths.length - changed.length) / createdPaths.length).toFixed(4)),
    categories: Object.fromEntries(
      Object.entries(excluded).map(([category, paths]) => [category, { files: paths.length, leaked: 0 }]),
    ),
  }
  log(`exclusion: ${exclusion.included}/${exclusion.candidates} candidates tracked (hit rate ${(exclusion.hitRate * 100).toFixed(1)}%)`)

  // ── phase B: establish/seal durations + incremental storage delta ─────────
  const establishSamples = [exclusionBase.elapsedMs]
  const sealSamples = [exclusionSeal.elapsedMs]
  const incrementalBytes = []
  for (let i = 1; i < runCount; i++) {
    const runId = nextRunId('baseline')
    const before = await dirBytes(shadowDir)
    const base = await createBase(runId)
    const seal = await sealRun(runId)
    establishSamples.push(base.elapsedMs)
    sealSamples.push(seal.elapsedMs)
    incrementalBytes.push(Math.max(0, (await dirBytes(shadowDir)) - before))
    assertEqual((seal.payload.changedFiles ?? []).length, 0, 'unchanged baseline run change set')
  }
  const establish = { samplesMs: establishSamples, medianMs: median(establishSamples), p95Ms: percentile(establishSamples, 0.95) }
  const seal = { samplesMs: sealSamples, medianMs: median(sealSamples), p95Ms: percentile(sealSamples, 0.95) }
  const storage = {
    fixtureBytes,
    firstRunBytes,
    incrementalBytesMedian: median(incrementalBytes),
    incrementalBytesSamples: incrementalBytes,
    ratio: Number((firstRunBytes / Math.max(1, fixtureBytes)).toFixed(4)),
  }
  log(`establish median=${establish.medianMs}ms p95=${establish.p95Ms}ms | seal median=${seal.medianMs}ms p95=${seal.p95Ms}ms`)
  log(`storage: fixture=${fixtureBytes}B firstRun=${firstRunBytes}B incremental(median)=${storage.incrementalBytesMedian}B ratio=${storage.ratio}`)

  // ── phase C: revert durations (cold/warm) for each requested size ─────────
  const reverts = []
  for (const size of revertSizes) {
    const cases = []
    for (const temperature of ['cold', 'warm']) {
      const runId = nextRunId(`revert-${size}-${temperature}`)
      await createBase(runId)
      for (let i = 0; i < size; i++) {
        await writeFixtureFile(`revert-cases/${size}/${temperature}/file-${i}.txt`, `revert case ${size}/${temperature}/${i}\n`)
      }
      const sealResult = await sealRun(runId)
      assertEqual((sealResult.payload.changedFiles ?? []).length, size, `${size}-file revert case seal change set`)

      const preview = await previewRevert(runId)
      assertEqual(preview.payload.counts?.delete, size, `${size}-file revert preview delete count`)
      assertEqual(preview.payload.counts?.skipConflicts, 0, `${size}-file revert preview conflict count`)

      const execute = await executeRevert(runId)
      assertEqual(execute.payload.counts?.deleted, size, `${size}-file revert deleted count`)
      assertEqual(execute.payload.counts?.failed, 0, `${size}-file revert failed count`)
      assertEqual(execute.payload.counts?.skippedConflict, 0, `${size}-file revert skipped count`)

      cases.push({
        temperature,
        runId,
        wallMs: execute.elapsedMs,
        runtimeDurationMs: execute.payload.durationMs,
        perFileMs: Number((execute.elapsedMs / size).toFixed(2)),
        deleted: execute.payload.counts?.deleted ?? null,
      })
      log(`revert ${size} file(s) ${temperature}: wall=${execute.elapsedMs}ms runtime=${execute.payload.durationMs}ms perFile=${(execute.elapsedMs / size).toFixed(2)}ms`)
    }
    reverts.push({ files: size, cases })
  }

  // ── thresholds verdict + report ───────────────────────────────────────────
  // The V17 per-file budget is a *marginal* cost: a 1-file revert is dominated by fixed git
  // spawn/lease overhead, so the meaningful comparison is (100 files - 1 file) / 99 extra files.
  const oneFile = reverts.find((entry) => entry.files === 1)
  const hundredFiles = reverts.find((entry) => entry.files === 100)
  const checks = [
    { metric: 'establish median', measured: establish.medianMs, limit: BUDGET.establishMedianMs, unit: 'ms', pass: establish.medianMs <= BUDGET.establishMedianMs },
    { metric: 'establish P95', measured: establish.p95Ms, limit: BUDGET.establishP95Ms, unit: 'ms', pass: establish.p95Ms <= BUDGET.establishP95Ms },
    { metric: 'seal median', measured: seal.medianMs, limit: BUDGET.sealMedianMs, unit: 'ms', pass: seal.medianMs <= BUDGET.sealMedianMs },
    { metric: 'seal P95', measured: seal.p95Ms, limit: BUDGET.sealP95Ms, unit: 'ms', pass: seal.p95Ms <= BUDGET.sealP95Ms },
    { metric: 'storage ratio (first run vs fixture)', measured: storage.ratio, limit: BUDGET.storageRatio, unit: 'x', pass: storage.ratio <= BUDGET.storageRatio },
  ]
  const marginal = []
  if (hundredFiles) {
    for (const cold of hundredFiles.cases) {
      const counterpart = oneFile?.cases.find((entry) => entry.temperature === cold.temperature)
      checks.push({ metric: `revert 100 files (${cold.temperature})`, measured: cold.wallMs, limit: BUDGET.revert100FilesMs, unit: 'ms', pass: cold.wallMs <= BUDGET.revert100FilesMs })
      if (counterpart) {
        const perExtraFile = Number(((cold.wallMs - counterpart.wallMs) / 99).toFixed(2))
        marginal.push({ temperature: cold.temperature, perExtraFileMs: perExtraFile })
        checks.push({
          metric: `revert marginal per file (${cold.temperature})`,
          measured: perExtraFile,
          limit: BUDGET.revertPerFileMs,
          unit: 'ms',
          pass: perExtraFile <= BUDGET.revertPerFileMs,
        })
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    runtime: { baseUrl, gitVersion: checkpoint.gitVersion ?? null, shadowRoot: checkpoint.shadowRoot ?? null },
    fixture: {
      workspaceId,
      workspaceDir,
      shadowDir,
      files: fileCount,
      bytes: fixtureBytes,
      runIds,
      cleanup: 'not performed by this script (probe never deletes); recycle with the e2e host root',
    },
    exclusion,
    establish,
    seal,
    storage,
    reverts,
    marginalPerFile: marginal,
    thresholds: { budget: BUDGET, checks, allPassed: checks.every((check) => check.pass) },
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function markdown(report) {
  const rows = []
  rows.push('| metric | measured | limit | verdict |')
  rows.push('| --- | --- | --- | --- |')
  for (const check of report.thresholds.checks) {
    rows.push(`| ${check.metric} | ${check.measured} ${check.unit} | ≤ ${check.limit} ${check.unit} | ${check.pass ? 'PASS' : 'FAIL'} |`)
  }
  const revertRows = report.reverts.flatMap((entry) =>
    entry.cases.map((sample) =>
      `| revert ${entry.files} file(s) ${sample.temperature} (informational) | wall ${sample.wallMs} ms / runtime ${sample.runtimeDurationMs} ms (${sample.perFileMs} ms/file incl. fixed overhead) | - | - |`),
  )
  return [
    '',
    '### checkpoint budget',
    '',
    `- workspace fixture: ${report.fixture.workspaceId} (${report.fixture.files} files, ${report.fixture.bytes} bytes)`,
    `- exclusion hit rate: ${(report.exclusion.hitRate * 100).toFixed(1)}% (${report.exclusion.excluded}/${report.exclusion.candidates} candidates excluded)`,
    `- establish: median ${report.establish.medianMs} ms / P95 ${report.establish.p95Ms} ms (${report.establish.samplesMs.length} samples)`,
    `- seal: median ${report.seal.medianMs} ms / P95 ${report.seal.p95Ms} ms`,
    `- storage: first run ${report.storage.firstRunBytes} B, incremental median ${report.storage.incrementalBytesMedian} B, ratio ${report.storage.ratio}x`,
    `- cleanup: ${report.fixture.cleanup}`,
    '',
    ...rows,
    ...(revertRows.length > 0 ? ['', '| revert sample | measured | limit | verdict |', '| --- | --- | --- | --- |', ...revertRows] : []),
    '',
  ].join('\n')
}

try {
  const report = await report()
  const json = JSON.stringify(report, null, 2)
  console.log(json)
  console.log(markdown(report))
  if (outPath) {
    const absolute = resolve(outPath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, outPath.endsWith('.md') ? markdown(report) : json)
    console.log(`[budget] report written: ${absolute}`)
  }
  process.exitCode = report.thresholds.allPassed ? 0 : 1
} catch (error) {
  console.error(`[budget] failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
