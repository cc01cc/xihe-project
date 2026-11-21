/**
 * task-42: **one** CP jar-state sample per run, shared by the boot plan and the window gate.
 *
 * The defect this removes (task-17 結項裁定 C, carried into task-42): `resolveCpBootPlan()` read the jar directory,
 * the sidecar and the jar's bytes, and `scripts/e2e-preflight.mjs` read the **same three things a
 * second time** in a child process. The preflight-前自愈 branch was only reachable when those two
 * independent samples disagreed ("boot plan says fresh, gate says stale") — so the branch that exists
 * to *repair* the artifact had its reachability handed by a read gap. An unreproducible branch cannot
 * be acceptance-tested, and J1 of task-17 could never be answered honestly.
 *
 * The fix is not "sample twice and compare notes". It is: sample **once**, give the sample an id, and
 * hand that same sample to the gate. Concretely:
 *
 * - `sampleCpJarBytes()` — the one read that costs something: list the build dir, pick the newest jar,
 *   hash its bytes, read its sidecar. Returns the pair both decisions are derived from.
 * - `buildJarSnapshot()` — turn one jar-state sample into a serialisable record.
 * - `snapshotId()` — the observable id (`snap-<runId>-<seq>`) printed by both sides, so a log line and a
 *   preflight verdict can be proved to describe the same sample.
 * - `writeJarSnapshotFile()` / `loadJarSnapshot()` — the boot plan and the gate are different processes,
 *   so "one sample" must cross a process boundary; the file lives under the run's own
 *   `.tmp/e2e-host/<runId>/logs/` and is recycled with the run dir.
 * - `loadJarSnapshot()` — the handoff must not become a way to pass stale evidence forward. A snapshot
 *   that is too old, that describes a different build dir, or whose jar was replaced after the sample
 *   is **refused**, not silently re-sampled ("未知不等于安全"; the criterion is never loosened here).
 *
 * Explicit refresh point: the only legal moment to produce a new sample is **after** a jar was written
 * (`stampCpArtifact()` returned), which is where `seq` advances. Between samples nothing re-reads disk.
 *
 * No absolute paths in the record: the jar sits outside the checkout (`XIHE_CP_TARGET_DIR`, default
 * `C:/xihe-build/e2e`), so a machine path would be unportable and meaningless anyway. The gate resolves
 * the build dir itself, so the snapshot only has to say *which artifact inside it* was sampled
 * (`jar.name` / `jar.bytes` / `jar.mtimeMs`) and what the sample concluded.
 *
 * Deliberately excluded (膨胀门, and the card forbids it): no `--force-self-heal` escape hatch, no
 * relaxed `artifact-truth`, no change to `--jar-mode=rebuild` semantics. The pure functions below take
 * injected `readFile`/`stat`/`now`, so every branch is unit-testable without a stack, Docker or Maven.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Snapshot wire format version. Adding a field does not bump it; changing semantics must. */
export const JAR_SNAPSHOT_SCHEMA = 1

/**
 * How old a handed-off sample may be when the gate reads it. The gate normally consumes a snapshot that
 * was written seconds earlier in the same window; anything older means the boot plan's decision is no
 * longer this window's decision, and a sample that cannot vouch for the artifact must not open the
 * window by being ignored.
 * Refusing is safe: the gate then samples for itself and judges exactly as it did before task-42 — an
 * expired snapshot can never make a run *looser*.
 */
export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000

/** Where the runner parks the snapshot for the preflight child (relative to the run's log dir). */
export const JAR_SNAPSHOT_FILE_NAME = 'cp-jar-snapshot.json'

/** The reasons `loadJarSnapshot()` can refuse with, in one place so the wording stays greppable. */
export const SNAPSHOT_REFUSALS = Object.freeze({
  absent: 'no snapshot file was handed to the gate',
  unusable: 'the snapshot file is not a usable task-42 record',
  expired: 'the snapshot is older than the gate will accept',
  foreignTarget: 'the snapshot describes a different CP build dir than the one being checked',
  substituted: 'the jar on disk is not the artifact the snapshot sampled',
})

/**
 * `snap-<runId>-<seq>` — readable, greppable in both logs, and unique per sample.
 *
 * Only `[A-Za-z0-9_-]` survives from the run id: the id is printed inside log lines and used to line up
 * two processes' output, so whitespace (breaks greppability) and dots/slashes (a `..` inside an
 * identifier reads like a path and invites someone to build one out of it) are stripped, not escaped.
 */
export function snapshotId({ runId, seq }) {
  const run = String(runId ?? 'unknown').replace(/[^a-z0-9_-]/gi, '')
  const n = Number.isInteger(seq) && seq > 0 ? seq : 1
  return `snap-${run}-${n}`
}

/** Normalise a build dir so a Windows `\` path from the runner compares equal to a `/` path in the gate. */
export function normalizeTargetDir(dir) {
  return String(dir ?? '').replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase()
}

/**
 * Read the jar's identity **once**: the bytes to hash and the sidecar that describes them.
 *
 * This is the seam task-42 needed. Before it, `resolveCpJarState()` hashed the jar and read the sidecar,
 * and the preflight hashed the same jar and read the same sidecar again — two samples, one verdict
 * each. The pair returned here is what `evaluateSidecar({ sample })` consumes downstream, so the boot
 * plan and the gate run the *same* state machine over the *same* bytes.
 *
 * @param {{jarPath: string|null, readSidecar: (input: {jarPath: string}) => object,
 *          sha256File: (file: string) => object}} input
 * @returns {{sidecarRead: object|null, jarHash: object|null}}
 */
export function sampleCpJarBytes({ jarPath, readSidecar, sha256File }) {
  if (!jarPath) return { sidecarRead: null, jarHash: null }
  return { sidecarRead: readSidecar({ jarPath }), jarHash: sha256File(jarPath) }
}

/**
 * Build the serialisable record for one jar-state sample.
 *
 * `state` is whatever `resolveCpJarState()` returned; only fields that were **read from disk** are
 * carried, because the point is that the gate does not read them again. `state.sample` is the pair from
 * `sampleCpJarBytes()` — the gate feeds it to the same reader state machine, so both decisions come from
 * the same bytes.
 *
 * @param {{
 *   state: object,
 *   targetDir: string,
 *   runId: string,
 *   seq?: number,
 *   sampledBy?: string,
 *   now?: () => number,
 * }} input
 * @returns {object} the snapshot record
 */
export function buildJarSnapshot({ state, targetDir, runId, seq = 1, sampledBy = 'boot-plan', now = Date.now }) {
  const jar = state?.jar ?? null
  const sample = state?.sample ?? null
  const hash = sample?.jarHash ?? null
  const read = sample?.sidecarRead ?? null
  return {
    schema: JAR_SNAPSHOT_SCHEMA,
    id: snapshotId({ runId, seq }),
    runId: String(runId ?? ''),
    seq,
    sampledBy,
    sampledAt: new Date(now()).toISOString(),
    targetDir: String(targetDir ?? '').replaceAll('\\', '/'),
    jar: jar ? { name: jar.name, bytes: hash?.bytes ?? null, mtimeMs: jar.mtimeMs } : null,
    jarSha256: hash?.ok ? hash.sha256 : null,
    hashError: hash === null ? 'the jar was never sampled (no jar in the build dir)' : (hash.ok ? null : hash.error),
    // The pair the reader state machine consumes, verbatim except for the absolute path (see the header).
    // No jar ⇒ no reusable pair at all: the gate must then read the artifact itself rather than receive
    // an all-`null` "sample" that would look like a handoff.
    sample: jar
      ? {
          sidecar: read
            ? { state: read.state, name: read.file ? basename(read.file) : null, data: read.data ?? null, error: read.error ?? null }
            : null,
          jarHash: hash
            ? { ok: Boolean(hash.ok), sha256: hash.sha256 ?? null, bytes: hash.bytes ?? null, error: hash.error ?? null }
            : null,
        }
      : null,
    newestSourceMtimeMs: state?.newestSource?.mtimeMs ?? null,
    identity: state?.sidecar ? { state: state.sidecar.state, identity: state.sidecar.identity, reason: state.sidecar.reason } : null,
  }
}

/**
 * Rebuild the `{sidecarRead, jarHash}` pair from a snapshot record. This is the **only** supported way
 * to turn the record back into a sample, so the boot plan and the gate cannot reconstruct it differently.
 *
 * Returns `null` when the sample holds no jar: there is nothing to reuse, and the caller must read the
 * artifact itself (a jar can legitimately appear between the boot plan's look and the gate's). Returning
 * an all-`null` pair instead would make the reader's `??` fallback look like an intentional handoff.
 *
 * @param {{snapshot: object, targetDir: string}} input
 * @returns {{sidecarRead: object|null, jarHash: object|null}|null}
 */
export function sampleFromSnapshot({ snapshot, targetDir }) {
  const sample = snapshot?.sample
  if (!sample || !snapshot?.jar) return null
  const dir = String(targetDir).replaceAll('\\', '/')
  const read = sample.sidecar
  const hash = sample.jarHash
  return {
    sidecarRead: read
      ? { state: read.state, file: read.name ? join(dir, read.name) : null, data: read.data ?? null, error: read.error ?? null }
      : null,
    jarHash: hash
      ? { ok: Boolean(hash.ok), sha256: hash.sha256 ?? null, bytes: hash.bytes ?? null, error: hash.error ?? null }
      : null,
  }
}

/**
 * Judge the shared sample with the **reader's own** state machine, from the runner side.
 *
 * Why the runner asks this at all: the preflight's artifact section knows one thing the boot plan's cheap
 * check does not — whether the sidecar's CP tree hash still equals HEAD's. That difference is what the
 * self-heal branch exists to repair, and before task-42 the branch could only notice it by reading disk a
 * *second* time (the read gap). Feeding `evaluateSidecar` the **same** sample the gate will use makes the
 * branch fire on content instead of on luck.
 *
 * Nothing here loosens the criterion: `artifact-truth` stays exactly what the reader calls it, and the
 * gate re-runs the same pure decision on the same bytes for itself. The content-evidence fallback is
 * deliberately not duplicated here (it belongs to the preflight, whose jar-inspection glue would drift);
 * `missing`/`degraded` therefore answer `fallback`, which callers must read as "the gate decides" — never
 * as "fresh".
 *
 * @param {{
 *   snapshot: object|null,
 *   targetDir: string,
 *   projectDir: string,
 *   evaluateSidecar: (input: object) => object,
 *   resolveArtifactTruth: (input: object) => object,
 *   run?: (command: string, args: string[], options?: object) => object,
 * }} input
 * @returns {{verdict: 'absent'|'fresh'|'stale'|'unverifiable'|'fallback', blocking: string|null,
 *            reason: string, state: string}}
 */
export function decideSharedSample({ snapshot, targetDir, projectDir, evaluateSidecar, resolveArtifactTruth, run }) {
  const jarName = snapshot?.jar?.name
  if (!jarName) return { verdict: 'absent', blocking: null, reason: 'the shared sample holds no jar', state: 'no-jar' }
  const sample = sampleFromSnapshot({ snapshot, targetDir })
  const sidecar = evaluateSidecar({ jarPath: join(String(targetDir).replaceAll('\\', '/'), jarName), projectDir, sample, run })
  const truth = resolveArtifactTruth({ sidecar, runFallback: () => null })
  if (truth.verdict === 'fallback') {
    return { verdict: 'fallback', blocking: null, reason: `${sidecar.state}: the content path decides (left to the gate)`, state: sidecar.state }
  }
  return { verdict: truth.verdict, blocking: truth.blocking ?? null, reason: sidecar.reason ?? truth.verdict, state: sidecar.state }
}

/**
 * Persist the snapshot so the gate's child process consumes **this** sample instead of reading disk again.
 * The runner treats a failed write as "the gate will sample for itself and say so", never as a pass/fail.
 *
 * @param {{file: string, snapshot: object, writeFile?: typeof writeFileSync, mkdir?: typeof mkdirSync}} input
 * @returns {{ok: boolean, file: string, bytes: number, error: string|null}}
 */
export function writeJarSnapshotFile({ file, snapshot, writeFile = writeFileSync, mkdir = mkdirSync }) {
  const text = `${JSON.stringify(snapshot, null, 2)}\n`
  try {
    // The run's log dir is created lazily by the runner; `recursive` makes this a no-op when it exists.
    mkdir(dirname(file), { recursive: true })
    writeFile(file, text, 'utf8')
    return { ok: true, file, bytes: Buffer.byteLength(text), error: null }
  } catch (error) {
    return { ok: false, file, bytes: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Load and verify the snapshot the runner handed over.
 *
 * @param {{
 *   file: string|null,
 *   targetDir: string,
 *   maxAgeMs?: number|null,
 *   now?: () => number,
 *   readFile?: typeof readFileSync,
 *   stat?: typeof statSync,
 * }} input
 * @returns {{verdict: 'ok'|'absent'|'unusable'|'expired'|'foreignTarget'|'substituted',
 *            snapshot: object|null, id: string|null, reason: string, file: string|null}}
 */
export function loadJarSnapshot({
  file,
  targetDir,
  maxAgeMs = DEFAULT_SNAPSHOT_MAX_AGE_MS,
  now = Date.now,
  readFile = readFileSync,
  stat = statSync,
}) {
  if (!file) return refuse('absent', null, null, null)
  let text
  try {
    text = readFile(file, 'utf8')
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null
    // A missing file is the standalone-preflight case (a human ran it, or the runner had no boot plan):
    // the gate samples for itself and says so. Any *other* read failure is an unusable record.
    if (code === 'ENOENT') return refuse('absent', null, null, file)
    return refuse('unusable', null, null, file, `cannot read the snapshot: ${error instanceof Error ? error.message : String(error)}`)
  }
  let snapshot
  try {
    snapshot = JSON.parse(String(text))
  } catch (error) {
    return refuse('unusable', null, null, file, `the snapshot is not JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return refuse('unusable', null, null, file, 'the snapshot is not a JSON object')
  }
  const id = typeof snapshot.id === 'string' ? snapshot.id : null
  if (snapshot.schema !== JAR_SNAPSHOT_SCHEMA) {
    return refuse('unusable', snapshot, id, file, `unsupported snapshot schema ${JSON.stringify(snapshot.schema)} (expected ${JAR_SNAPSHOT_SCHEMA})`)
  }
  if (!id || !Number.isFinite(Date.parse(String(snapshot.sampledAt ?? '')))) {
    return refuse('unusable', snapshot, id, file, 'the snapshot carries no id or no sample time')
  }
  if (snapshot.jar !== null && (typeof snapshot.jar !== 'object' || typeof snapshot.jar.name !== 'string' || snapshot.jar.name === '')) {
    return refuse('unusable', snapshot, id, file, 'the snapshot jar record is malformed')
  }
  if (normalizeTargetDir(snapshot.targetDir) !== normalizeTargetDir(targetDir)) {
    return refuse('foreignTarget', snapshot, id, file,
      `the snapshot was sampled for ${snapshot.targetDir} but the gate is checking ${targetDir}`)
  }
  const ageMs = now() - Date.parse(snapshot.sampledAt)
  if (Number.isFinite(maxAgeMs) && ageMs > maxAgeMs) {
    return refuse('expired', snapshot, id, file,
      `sampled ${Math.round(ageMs / 1000)}s ago (limit ${Math.round(maxAgeMs / 1000)}s) — a decision this old does not vouch for this window`)
  }
  if (snapshot.jar) {
    // The gate knows the build dir, so it can check the artifact the sample named — without the record
    // ever carrying an absolute path.
    const onDisk = `${String(targetDir).replaceAll('\\', '/')}/${snapshot.jar.name}`
    let disk
    try {
      disk = stat(onDisk)
    } catch (error) {
      return refuse('substituted', snapshot, id, file,
        `the sampled jar ${snapshot.jar.name} is gone (${error instanceof Error ? error.message : String(error)}) — something replaced the artifact after the sample`)
    }
    const bytesMatch = snapshot.jar.bytes === null || snapshot.jar.bytes === disk.size
    if (disk.mtimeMs !== snapshot.jar.mtimeMs || !bytesMatch) {
      return refuse('substituted', snapshot, id, file,
        `the sampled jar ${snapshot.jar.name} changed after the sample (mtime ${snapshot.jar.mtimeMs}→${disk.mtimeMs}, bytes ${snapshot.jar.bytes}→${disk.size})`)
    }
  }
  return { verdict: 'ok', snapshot, id, reason: 'the snapshot describes the artifact the gate is checking', file }

  function refuse(kind, record, recordId, path, detail) {
    const base = SNAPSHOT_REFUSALS[kind]
    return { verdict: kind, snapshot: record, id: recordId, reason: detail ? `${base}: ${detail}` : base, file: path ?? null }
  }
}

/**
 * One line naming the sample a verdict came from. Both processes print it, which is what makes J3
 * checkable by eye and by log grep: the boot plan, the self-heal and the preflight artifact section all
 * carry the same id.
 */
export function describeSnapshotSource({ id, jarName, sampledAt, now = Date.now, source }) {
  const ageMs = sampledAt ? now() - Date.parse(sampledAt) : Number.NaN
  const age = Number.isFinite(ageMs) ? ` ${Math.max(0, Math.round(ageMs / 1000))}s old` : ''
  return `shared sample ${id ?? 'UNKNOWN'} jar=${jarName ?? 'none'}${age} source=${source}`
}

