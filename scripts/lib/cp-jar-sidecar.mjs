/**
 * BL-477 / task-90: a **content fingerprint for the shared CP fat jar** — written next to the
 * artifact, never inside it.
 *
 * ## The gap this closes
 * `scripts/lib/e2e-build-artifact.mjs` (task-84) judges the jar by *content evidence*, but for
 * compiled `.java` sources the strongest evidence available was "the last commit is older than the
 * jar" plus "the class is present". That is an *interval* argument, not an identity: it cannot
 * prove the jar was produced from the tree that is checked out now.
 *
 * ## Why a sidecar and not `META-INF/build-info.properties`
 * The in-jar stamp is generated during the **package** phase by the Spring Boot build (and, for this
 * repo, *rewritten afterwards* by `scripts/stack-run.mjs` into `target/classes`), so the copy that
 * ends up inside the jar is always one generation behind. Measured on 2026-11-08: the jar carried
 * `commit=bd4dcf5c / builtAt=18:42:29Z` while it was repackaged at `19:59:02Z`, and
 * `git diff --name-only bd4dcf5c HEAD -- packages/control-plane` was **11 files** — i.e. the in-jar
 * stamp would manufacture a *new* false red if it were used as the criterion.
 *
 * A sidecar has no such lag: the **same code path that produced the jar** writes it immediately
 * afterwards, atomically (temp file + rename), and it records the jar's own hash — so a reader can
 * prove the manifest is about *this* jar rather than a leftover from an earlier build.
 *
 * ## Fields (schema 1)
 * - `jarName` / `jarBytes` — which artifact this describes, and how big it must be
 * - `jarSha256`            — the artifact's own hash: the identity anchor (strongest evidence)
 * - `commit`               — `git rev-parse HEAD` at build time
 * - `sourceTreeSha256`     — sha256 of `git ls-tree -r HEAD -- packages/control-plane` (free,
 *                            deterministic, recomputable by hand; see `sourceTreeSha256Command()`)
 * - `sourceScope`          — the pathspec the tree hash covers
 * - `builtAt`              — **packaging completion** time (ISO), never earlier than the jar mtime
 * - `dirty` / `writtenBy`  — honest provenance: a tree that was dirty at build time cannot be
 *                            proven from `commit`
 *
 * ## Reader priority (consumed by `scripts/e2e-preflight.mjs`)
 * 1. sidecar `jarSha256` == actual jar hash → `fresh` only if `sourceTreeSha256` also == HEAD tree
 * 2. sidecar present but jar hash differs → **`stale`, non-deferrable** (`artifact-truth`): the jar
 *    on disk is not the artifact the manifest describes
 * 3. sidecar missing → fall back to the task-84 content evidence path (never stricter, never looser)
 * 4. sidecar unreadable/corrupt → `unverifiable` (fail-closed; unknown is never green)
 * 5. identity ok but the tree hash cannot be recomputed (git unavailable, dirty tree, artifact
 *    built dirty) → fall back to content evidence
 *
 * ## Rejected alternatives (膨胀门)
 * - put the fields in the jar's `build-info.properties`: lags one generation (measured 77 min above).
 * - compare only `commit`: a rebuild from the same commit is invisible, and a dirty build lies.
 * - trust `builtAt` / mtime order: that is exactly the mtime-as-truth defect task-84 removed.
 * - hash the jar but skip the tree hash: then "same jar, newer sources" is undetectable.
 *
 * ## Forging must stay impossible-by-accident (measured 2026-11-08)
 * The one thing this module cannot verify is that the *current* tree actually produced the jar it is
 * told about — that is the producer's attestation. A demo run exposed the gap concretely: writing a
 * manifest for the existing shared jar (built from `bd4dcf5c` 81 minutes earlier) made the reader
 * report **`fresh`**, because the manifest recorded HEAD's tree for a jar built 11 files earlier.
 * Hence `buildSidecar` refuses when the jar's mtime is older than `maxWriteLagMs` (default 2 min,
 * while a real producer writes ~1 s after packaging): an after-the-fact manifest is rejected instead
 * of manufacturing a green verdict, and the caller simply falls back to content evidence. A new
 * git `ref` option to fingerprint an older tree was rejected — evidence-only scaffolding in the
 * production path would be the wrong shape, and the truthful-but-old manifest is exactly the thing
 * a hand-run forge would produce.
 *
 * ## What the write-lag guard does NOT cover (two separate gates)
 * `maxWriteLagMs` bounds **time**: "you are writing now about something built long ago". It says
 * nothing about the **tree changing during the build** — there `sourceTreeSha256` honestly records
 * the HEAD that was read, yet the jar may hold half-finished code. That axis is carried by `dirty`
 * plus the tree hash comparison: `dirty=true` or tree ≠ HEAD ⇒ the reader reports `degraded`/`stale`
 * and falls back to content evidence (`unverifiable` still blocks). Having 120 s does not mean
 * having identity.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { gitHead } from './cp-build-info.mjs';

/** Bumped only for a breaking field change; readers reject unknown schemas (fail-closed). */
export const SIDECAR_SCHEMA = 1;

/** The default pathspec whose tree hash identifies "the CP inputs". */
export const DEFAULT_SOURCE_SCOPE = 'packages/control-plane';

/**
 * How long after the jar was written a producer may still claim "I built this" (default 2 min).
 *
 * A real producer calls `writeSidecarForJar` immediately after `mvn package` returns, so the gap is
 * about a second. Anything much later is an *after-the-fact* manifest, and recording HEAD's tree for
 * a jar that was built from an older tree turns the strongest evidence into a false green (measured:
 * 81 minutes late ⇒ the reader answered `fresh` for a jar built 11 files earlier). Refusing is
 * fail-closed: the caller warns and the content path judges the artifact instead.
 */
export const DEFAULT_MAX_WRITE_LAG_MS = 120_000;

/** Field order is also the on-disk key order (byte-stable files diff cleanly). */
export const SIDECAR_FIELDS = Object.freeze([
  'schema',
  'jarName',
  'jarBytes',
  'jarSha256',
  'commit',
  'sourceTreeSha256',
  'sourceScope',
  'builtAt',
  'dirty',
  'writtenBy',
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** `<jar>.buildinfo.json` — per-artifact name so several jars in one dir cannot collide. */
export function sidecarFileName(jarName) {
  return `${String(jarName ?? '')}.buildinfo.json`;
}

/** @param {string} jarPath @returns {string} absolute sidecar path next to the jar */
export function sidecarPathFor(jarPath) {
  return join(dirname(String(jarPath ?? '')), sidecarFileName(basename(String(jarPath ?? ''))));
}

/** The exact command a human can run to reproduce `sourceTreeSha256`. */
export function sourceTreeSha256Command(scope = DEFAULT_SOURCE_SCOPE) {
  return `git ls-tree -r HEAD -- ${scope} | sha256sum`;
}

/** @param {Buffer|string} input @returns {string} lowercase hex sha256 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Hash a file's **bytes** (never its mtime, size or listing text).
 *
 * @param {string} file
 * @param {{readFile?: typeof readFileSync}} [deps]
 * @returns {{ok: boolean, sha256: string|null, bytes: number|null, error: string|null}}
 */
export function sha256File(file, { readFile = readFileSync } = {}) {
  try {
    const buffer = readFile(file);
    return { ok: true, sha256: sha256Hex(buffer), bytes: buffer.length, error: null };
  } catch (error) {
    return { ok: false, sha256: null, bytes: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Hash the CP source tree at HEAD: sha256 over the raw `git ls-tree -r HEAD -- <scope>` bytes.
 *
 * Why this and not a hand-rolled walk: `ls-tree` is git's own canonical listing (mode, type, blob
 * id, tab, path — one LF-terminated line per file), so the value is stable across checkouts,
 * filesystems and line-ending settings, and any single file can be cross-checked against its blob
 * id with `git hash-object`. The hash covers **bytes**, not the decoded string, so a change to the
 * listing can never be normalised away.
 *
 * @param {{projectDir: string, scope?: string, run?: typeof spawnSync}} input
 * @returns {{ok: boolean, sha256: string|null, entries: number|null, commit: string|null, error: string|null}}
 */
export function computeSourceTreeSha256({ projectDir, scope = DEFAULT_SOURCE_SCOPE, run = spawnSync }) {
  const result = run('git', ['ls-tree', '-r', 'HEAD', '--', scope], { cwd: projectDir, maxBuffer: 64 * 1024 * 1024 });
  if (!result || result.status !== 0) {
    const stderr = result && result.stderr ? String(result.stderr).trim() : '';
    return { ok: false, sha256: null, entries: null, commit: null, error: stderr || `git ls-tree exited ${result?.status ?? 'null'}` };
  }
  const buffer = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ''), 'utf8');
  const text = buffer.toString('utf8');
  const entries = text === '' ? 0 : text.split('\n').filter((line) => line.trim() !== '').length;
  if (entries === 0) {
    return { ok: false, sha256: null, entries: 0, commit: null, error: `git ls-tree listed no files under ${scope} (wrong checkout or empty scope)` };
  }
  return { ok: true, sha256: sha256Hex(buffer), entries, commit: null, error: null };
}

/**
 * Build the sidecar payload for a jar that was just produced. Pure apart from the injected deps.
 *
 * `builtAt` is **clamped** to the jar's mtime: a clock behind the filesystem would otherwise let a
 * manifest claim it predates the artifact it describes (`builtAt < jar.mtime` is the ordering task-90
 * verifies). A jar that is *older* than `maxWriteLagMs` is refused outright — see the module docblock
 * ("Forging must stay impossible-by-accident").
 *
 * @param {{
 *   projectDir: string,
 *   jarPath: string,
 *   writtenBy?: string,
 *   scope?: string,
 *   now?: () => number,
 *   maxWriteLagMs?: number,
 *   run?: typeof spawnSync,
 *   readFile?: typeof readFileSync,
 *   stat?: typeof statSync,
 * }} input
 * @returns {{ok: boolean, data: object|null, error: string|null}}
 */
export function buildSidecar({
  projectDir,
  jarPath,
  writtenBy = 'unknown',
  scope = DEFAULT_SOURCE_SCOPE,
  now = Date.now,
  maxWriteLagMs = DEFAULT_MAX_WRITE_LAG_MS,
  run = spawnSync,
  readFile = readFileSync,
  stat = statSync,
}) {
  const file = sidecarPathFor(jarPath);
  let jarStat;
  try {
    jarStat = stat(jarPath);
  } catch (error) {
    return { ok: false, data: null, error: `cannot stat the jar ${jarPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const nowMs = now();
  const jarMtimeMs = jarStat.mtimeMs;
  const writeLagMs = nowMs - jarMtimeMs;
  if (Number.isFinite(maxWriteLagMs) && writeLagMs > maxWriteLagMs) {
    return {
      ok: false,
      data: null,
      error:
        `refusing to fingerprint a jar written ${Math.round(writeLagMs / 1000)}s before now (limit ${Math.round(maxWriteLagMs / 1000)}s):`
        + ' a manifest written after the fact would claim the current tree built this artifact, which is exactly the false green'
        + ' the fingerprint exists to prevent — run the build and write the sidecar from the same invocation',
    };
  }
  const hashed = sha256File(jarPath, { readFile });
  if (!hashed.ok) return { ok: false, data: null, error: `cannot hash the jar: ${hashed.error}` };
  const head = gitHead({ cwd: projectDir, run });
  if (!head.commit) return { ok: false, data: null, error: `cannot resolve git HEAD (${head.error}); refusing to write an unstamped sidecar` };
  const tree = computeSourceTreeSha256({ projectDir, scope, run });
  if (!tree.ok) return { ok: false, data: null, error: `cannot hash the CP source tree: ${tree.error}` };
  const builtAtMs = Math.max(nowMs, jarMtimeMs);
  const data = {
    schema: SIDECAR_SCHEMA,
    jarName: basename(jarPath),
    jarBytes: hashed.bytes,
    jarSha256: hashed.sha256,
    commit: head.commit,
    sourceTreeSha256: tree.sha256,
    sourceScope: scope,
    builtAt: new Date(builtAtMs).toISOString(),
    dirty: head.dirty === true,
    writtenBy,
  };
  return {
    ok: true,
    data,
    error: null,
    file,
    // Reported so a caller can log "the clock was behind" instead of silently reordering.
    clockSkewMs: nowMs < jarMtimeMs ? jarMtimeMs - nowMs : 0,
    treeEntries: tree.entries,
  };
}

/**
 * Write the sidecar atomically (temp file + rename in the same directory).
 *
 * Ordering contract: the caller writes **after** the jar has been produced, so
 * `mtime(sidecar) >= mtime(jar)` and `builtAt >= jar.mtime`. A crash between the two leaves the
 * previous sidecar describing a jar that no longer exists → the reader reports
 * `identity-mismatch` (stale, non-deferrable) rather than a false green.
 *
 * @param {{sidecarPath: string, data: object, writeFile?: typeof writeFileSync, rename?: typeof renameSync,
 *          mkdir?: typeof mkdirSync, unlink?: typeof unlinkSync, pid?: number}} input
 * @returns {{ok: boolean, file: string, tempFile: string, error: string|null}}
 */
export function writeSidecarAtomic({
  sidecarPath,
  data,
  writeFile = writeFileSync,
  rename = renameSync,
  mkdir = mkdirSync,
  unlink = unlinkSync,
  pid = process.pid,
}) {
  const file = String(sidecarPath);
  const tempFile = `${file}.tmp-${pid}`;
  const text = `${JSON.stringify(orderedFields(data), null, 2)}\n`;
  try {
    mkdir(dirname(file), { recursive: true });
    writeFile(tempFile, text, 'utf8');
    rename(tempFile, file);
    return { ok: true, file, tempFile, error: null };
  } catch (error) {
    // A half-written temp file must not be left behind: the reader only looks at `file`, but a
    // leftover would be mistaken for evidence by a human doing `ls`.
    try {
      unlink(tempFile);
    } catch {
      // already gone / never created — nothing to clean
    }
    return { ok: false, file, tempFile, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Fixed key order, unknown keys dropped (a sidecar is a wire format, not a scratch pad). */
function orderedFields(data) {
  const out = {};
  for (const key of SIDECAR_FIELDS) if (data && key in data) out[key] = data[key];
  return out;
}

/**
 * Build + write in one call; the two steps are separated above only so each can be tested.
 *
 * @param {Parameters<typeof buildSidecar>[0]} input plus `{writeFile?, rename?}`
 */
export function writeSidecarForJar(input) {
  const built = buildSidecar(input);
  const file = sidecarPathFor(input.jarPath);
  if (!built.ok) return { ok: false, file, data: null, error: built.error };
  const written = writeSidecarAtomic({ sidecarPath: file, data: built.data, writeFile: input.writeFile, rename: input.rename });
  return { ok: written.ok, file: written.file, data: built.data, error: written.error, clockSkewMs: built.clockSkewMs };
}

/**
 * Strict reader. Anything unexpected is `invalid` (not `missing`): a corrupt manifest is evidence of
 * tampering or a broken writer, and must not silently degrade into "no manifest here".
 *
 * @param {string} text
 * @returns {{ok: boolean, data: object|null, error: string|null}}
 */
export function parseSidecar(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch (error) {
    return { ok: false, data: null, error: `not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, data: null, error: 'not a JSON object' };
  if (parsed.schema !== SIDECAR_SCHEMA) return { ok: false, data: null, error: `unsupported schema ${JSON.stringify(parsed.schema)} (expected ${SIDECAR_SCHEMA})` };
  if (typeof parsed.jarName !== 'string' || parsed.jarName === '') return { ok: false, data: null, error: 'jarName missing' };
  if (!Number.isInteger(parsed.jarBytes) || parsed.jarBytes <= 0) return { ok: false, data: null, error: 'jarBytes must be a positive integer' };
  if (!SHA256_RE.test(String(parsed.jarSha256 ?? ''))) return { ok: false, data: null, error: 'jarSha256 must be 64 lowercase hex chars' };
  if (!COMMIT_RE.test(String(parsed.commit ?? ''))) return { ok: false, data: null, error: 'commit must be a full git object id' };
  if (!SHA256_RE.test(String(parsed.sourceTreeSha256 ?? ''))) return { ok: false, data: null, error: 'sourceTreeSha256 must be 64 lowercase hex chars' };
  if (typeof parsed.sourceScope !== 'string' || parsed.sourceScope === '') return { ok: false, data: null, error: 'sourceScope missing' };
  if (!Number.isFinite(Date.parse(String(parsed.builtAt ?? '')))) return { ok: false, data: null, error: 'builtAt is not an ISO timestamp' };
  if (typeof parsed.dirty !== 'boolean') return { ok: false, data: null, error: 'dirty must be a boolean' };
  if (typeof parsed.writtenBy !== 'string' || parsed.writtenBy === '') return { ok: false, data: null, error: 'writtenBy missing' };
  return { ok: true, data: orderedFields(parsed), error: null };
}

/**
 * Read the sidecar that belongs to `jarPath`.
 *
 * @param {{jarPath: string, readFile?: typeof readFileSync}} input
 * @returns {{state: 'ok'|'missing'|'invalid', file: string, data: object|null, error: string|null}}
 */
export function readSidecar({ jarPath, readFile = readFileSync }) {
  const file = sidecarPathFor(jarPath);
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (error) {
    // Absence is not an error: artifacts built before task-90 (and plain `mvn package` runs) have
    // no sidecar, and the content-evidence path still applies to them. Any *other* read failure is
    // a manifest that exists but cannot be used — that must not look like "nothing here".
    const code = error && typeof error === 'object' ? error.code : null;
    if (code === 'ENOENT') return { state: 'missing', file, data: null, error: null };
    return { state: 'invalid', file, data: null, error: `cannot read the sidecar: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseSidecar(text);
  return { state: parsed.ok ? 'ok' : 'invalid', file, data: parsed.data, error: parsed.error };
}

/**
 * The whole reader decision for one jar.
 *
 * States (all consumed by `resolveArtifactTruth`):
 * - `fresh`             identity ok **and** the recorded tree == the tree checked out now
 * - `stale`             identity ok, but the jar was built from a different CP tree than HEAD
 * - `identity-mismatch` the jar on disk is not the artifact the manifest describes
 * - `invalid`           manifest present but unusable
 * - `missing`           no manifest (pre-task-90 artifact)
 * - `degraded`          identity ok, tree comparison impossible (git unavailable / dirty tree /
 *                       artifact built from a dirty tree) → caller falls back to content evidence
 *
 * @param {{
 *   jarPath: string,
 *   projectDir: string,
 *   scope?: string,
 *   run?: typeof spawnSync,
 *   readFile?: typeof readFileSync,
 *   now?: () => number,
 * }} input
 */
export function evaluateSidecar({ jarPath, projectDir, scope = DEFAULT_SOURCE_SCOPE, run = spawnSync, readFile = readFileSync }) {
  const read = readSidecar({ jarPath, readFile });
  if (read.state === 'missing') return { state: 'missing', file: read.file, data: null, reason: 'no sidecar manifest next to the jar' };
  if (read.state === 'invalid') return { state: 'invalid', file: read.file, data: null, reason: `the sidecar is unusable: ${read.error}` };

  const data = read.data;
  const actual = sha256File(jarPath, { readFile });
  if (!actual.ok) {
    // The artifact itself is unreadable: that is not "no manifest", it is unprovable.
    return { state: 'invalid', file: read.file, data, reason: `cannot hash the jar to check the manifest: ${actual.error}` };
  }
  if (actual.sha256 !== data.jarSha256 || basename(jarPath) !== data.jarName) {
    return {
      state: 'identity-mismatch',
      file: read.file,
      data,
      reason:
        `the manifest describes ${data.jarName} (sha256 ${data.jarSha256.slice(0, 12)}…),`
        + ` but the jar on disk is ${basename(jarPath)} (sha256 ${actual.sha256.slice(0, 12)}…)`,
      expectedJarSha256: data.jarSha256,
      actualJarSha256: actual.sha256,
    };
  }
  if (data.dirty === true) {
    return { state: 'degraded', file: read.file, data, reason: 'the artifact was built from a dirty tree, so its tree hash cannot prove the jar matches HEAD' };
  }
  const tree = computeSourceTreeSha256({ projectDir, scope: data.sourceScope || scope, run });
  if (!tree.ok) return { state: 'degraded', file: read.file, data, reason: `cannot recompute the CP source tree hash: ${tree.error}` };
  const head = gitHead({ cwd: projectDir, run });
  if (!head.commit) return { state: 'degraded', file: read.file, data, reason: `cannot resolve git HEAD: ${head.error}` };
  if (head.dirty) {
    return { state: 'degraded', file: read.file, data, reason: 'the CP tree has uncommitted changes, so HEAD cannot describe what the jar should contain' };
  }
  if (tree.sha256 === data.sourceTreeSha256) {
    return {
      state: 'fresh',
      file: read.file,
      data,
      headCommit: head.commit,
      treeEntries: tree.entries,
      reason: `the jar is byte-identical to the artifact built from ${data.commit.slice(0, 12)} (tree ${tree.sha256.slice(0, 12)}…)`,
    };
  }
  return {
    state: 'stale',
    file: read.file,
    data,
    reason:
      `the jar was built from tree ${data.sourceTreeSha256.slice(0, 12)}…, but HEAD is ${tree.sha256.slice(0, 12)}…`
      + ` (${data.commit.slice(0, 12)} → ${head.commit.slice(0, 12)})`,
    headCommit: head.commit,
    headTreeSha256: tree.sha256,
    changedCount: countChangedSources({ projectDir, fromCommit: data.commit, scope: data.sourceScope || scope, run }),
  };
}

/**
 * How many CP files differ between the artifact's commit and HEAD (display/help only; a failed git
 * call yields null, never 0, so the message cannot claim "nothing changed").
 *
 * @param {{projectDir: string, fromCommit: string, scope: string, run?: typeof spawnSync}} input
 * @returns {number|null}
 */
export function countChangedSources({ projectDir, fromCommit, scope, run = spawnSync }) {
  if (!COMMIT_RE.test(String(fromCommit ?? ''))) return null;
  const result = run('git', ['diff', '--name-only', `${fromCommit}..HEAD`, '--', scope], { cwd: projectDir, encoding: 'utf8' });
  if (!result || result.status !== 0) return null;
  const text = String(result.stdout ?? '').trim();
  return text === '' ? 0 : text.split('\n').filter((line) => line.trim() !== '').length;
}

/**
 * Compose the sidecar verdict with the task-84 content-evidence path.
 *
 * The mapping is the contract task-90 fixes:
 * - `fresh`             → fresh, nothing else is consulted (no mtime, no per-file scan)
 * - `stale`             → stale on the **`build`** scope: deferrable, because the pre-gate rebuild
 *                         (`resolveCpBootPlan()` runs before the gate) regenerates jar + sidecar and
 *                         heals it — making it non-deferrable would re-create the task-76 deadlock
 * - `identity-mismatch` → stale but **non-deferrable** (`artifact-truth`): a jar that is not the
 *                         fingerprinted artifact cannot be explained by "sources moved on", and a
 *                         rebuild is required either way
 * - `invalid`           → `unverifiable`, non-deferrable (unknown is never green)
 * - `missing`/`degraded`→ fall back to the content path (behaviour **identical** to task-84)
 *
 * @param {{sidecar: ReturnType<typeof evaluateSidecar>, runFallback: () => object}} input
 * @returns {{verdict: 'fresh'|'stale'|'unverifiable'|'fallback', blocking: 'build'|'artifact-truth'|null,
 *            source: 'sidecar'|'content', sidecar: object, fallback: object|null}}
 */
export function resolveArtifactTruth({ sidecar, runFallback }) {
  const state = sidecar?.state;
  if (state === 'fresh') return { verdict: 'fresh', blocking: null, source: 'sidecar', sidecar, fallback: null };
  if (state === 'stale') return { verdict: 'stale', blocking: 'build', source: 'sidecar', sidecar, fallback: null };
  if (state === 'identity-mismatch') return { verdict: 'stale', blocking: 'artifact-truth', source: 'sidecar', sidecar, fallback: null };
  if (state === 'invalid') return { verdict: 'unverifiable', blocking: 'artifact-truth', source: 'sidecar', sidecar, fallback: null };
  if (typeof runFallback !== 'function') throw new TypeError('resolveArtifactTruth needs runFallback for the missing/degraded states');
  return { verdict: 'fallback', blocking: null, source: 'content', sidecar, fallback: runFallback() };
}
