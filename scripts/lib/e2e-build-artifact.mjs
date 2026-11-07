/**
 * BL-477 / task-84 — the *fourth* preflight pathology: **the check points at a shared artifact
 * and treats `mtime` as truth**.
 *
 * The shared CP fat jar lives outside git (`C:/xihe-build/e2e`), so its own mtime is honest: it is
 * the moment Maven wrote the file and no checkout can rewrite it. The *sources* are the opposite:
 * `git checkout` / `git worktree` rewrite the mtime of every tracked file whose content differs
 * between the two sides, including files whose content is **byte-identical** to what the artifact
 * already contains. Comparing the two mtimes therefore reports "jar is older than sources by 5m"
 * for a jar that is in fact newer than every byte of code it needs — and it does that *only in the
 * checkout that just switched branches* (`V135__plan0691_plugins.sql`, mtime 04:04:04 from
 * `checkout: moving from ...`, vs jar 03:59:02; the same jar and the same source content read
 * green from the main checkout).
 *
 * So the criterion is replaced by **content truth first, time second**:
 *
 * 1. `membership` (exact): a source whose artifact-side entry is **absent** (`bsdtar -tf`) is not
 *    in the artifact at all ⇒ stale, whatever the clocks say.
 * 2. `sha256` (exact): anything the jar stores **verbatim** (`src/main/resources/**` → 
 *    `BOOT-INF/classes/**`) is compared byte for byte with the working-tree file. Equal ⇒ the
 *    artifact carries that content, whatever the mtimes say; different/missing ⇒ genuinely stale.
 * 3. `commit-time` (git truth, checkout-proof): for everything the jar does **not** store verbatim
 *    (`.java` → bytecode, `pom.xml`) the source side is the file's **last commit time** — an
 *    immutable fact that `git checkout` cannot move — compared with the artifact's write time.
 * 4. `mtime` only where there is no commit at all (dirty/untracked working-tree edits).
 * 5. Everything else is `unverifiable`, which is **blocking**: an unknown artifact is not a green
 *    window. This is the honest branch — the jar carries no input fingerprint (see
 *    `REQUIRED_STAMP_FIELDS` in the report for what would make it decidable).
 *
 * Rejected alternatives (膨胀门): a "tolerance factor" on the mtime delta (still arbitrary: a
 * checkout can move a file forward by seconds or by a year), reusing `build-info.properties` as
 * the authority (measured here: the stamp says `commit=bd4dcf5c builtAt=02:42` while the jar was
 * repackaged at 03:59 from a tree containing 11 more CP files — the stamp is written by
 * `stack-run.mjs`, not by `mvn package`, so it under-reports and would manufacture a *new* false
 * red), and "jar mtime vs newest source commit only" (drops the exact byte comparison for
 * resources, which is the one piece of real content provenance the artifact does provide).
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Where Maven puts `src/main/resources/**` inside a Spring Boot fat jar. */
export const ARTIFACT_CLASS_ROOT = 'BOOT-INF/classes/'
/** CP source roots that decide what the jar must contain. */
export const CP_RESOURCE_ROOT = 'src/main/resources/'
export const CP_JAVA_ROOT = 'src/main/java/'

/** Evidence kinds, ordered from strongest to weakest; reported so a green can be audited. */
export const ARTIFACT_EVIDENCE = Object.freeze({
  sha256: 'sha256',
  membership: 'membership',
  commitTime: 'commit-time',
  mtime: 'mtime',
})

/**
 * Map a CP-relative source path to what the artifact must contain for it.
 *
 * `resource` entries are stored byte for byte and can be compared exactly. `java` maps to a class
 * file, which carries no source identity (javac embeds no source hash), so it falls back to
 * commit-time evidence. Anything else (`pom.xml`, scratch files) has no artifact-side counterpart.
 *
 * @param {string} relPath path relative to `packages/control-plane`, either separator
 * @returns {{kind: 'resource'|'java'|'pom'|'other', entry: string|null}}
 */
export function classifyCpSource(relPath) {
  // Accept both `src/main/...` (package-relative) and `packages/control-plane/src/main/...`
  // (repo-relative, as git names it) — the caller's walker emits the latter.
  const path = String(relPath ?? '')
    .replace(/\\/g, '/')
    .replace(/^packages\/control-plane\//, '')
  if (path === 'pom.xml') return { kind: 'pom', entry: null }
  if (path.startsWith(CP_RESOURCE_ROOT)) {
    return { kind: 'resource', entry: ARTIFACT_CLASS_ROOT + path.slice(CP_RESOURCE_ROOT.length) }
  }
  if (path.startsWith(CP_JAVA_ROOT) && path.endsWith('.java')) {
    return { kind: 'java', entry: ARTIFACT_CLASS_ROOT + path.slice(CP_JAVA_ROOT.length).replace(/\.java$/, '.class') }
  }
  return { kind: 'other', entry: null }
}

/**
 * Every source file under `root` whose mtime is newer than the artifact.
 *
 * This set is the *trigger*, not the verdict: the whole point of the module is that a newer mtime
 * may still mean "same content, rewritten by a checkout". Keeping the set small (usually a handful
 * of files) is what allows an exact `sha256` comparison per file.
 *
 * @param {{root: string, sinceMs: number, prefix?: string, skipDirs?: string[]}} input
 * @returns {Array<{path: string, absPath: string, mtimeMs: number}>} newest first
 */
export function collectSourcesNewerThan({ root, sinceMs, prefix = '', skipDirs = ['node_modules', 'target', '.git'] }) {
  const out = []
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
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (!(stat.mtimeMs > sinceMs)) continue
      const rel = full.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      out.push({ path: prefix ? `${prefix}/${rel}` : rel, absPath: full, mtimeMs: stat.mtimeMs })
    }
  }
  out.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return out
}

/**
 * @param {Buffer|Uint8Array|string} bytes
 * @returns {string} lowercase hex sha256
 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Names of every entry in the jar, through `bsdtar -tf` (Windows' built-in `tar` reads zip
 * natively). Presence is decided separately from content: "the artifact does not contain this file
 * at all" is *stale*, not *unverifiable* — a different fact from "I could not read it".
 *
 * @param {{jarPath: string, spawn?: typeof spawnSync}} input
 * @returns {{ok: boolean, entries: Set<string>, error: string|null}}
 */
export function listJarEntries({ jarPath, spawn = spawnSync }) {
  if (!jarPath) return { ok: false, entries: new Set(), error: 'no jar path' }
  const result = spawn('tar', ['-tf', jarPath], {
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
    encoding: 'utf8',
  })
  if (result?.error) return { ok: false, entries: new Set(), error: String(result.error.message ?? result.error) }
  if (result?.status !== 0) {
    const stderr = String(result?.stderr ?? '').trim()
    return { ok: false, entries: new Set(), error: stderr || `tar exited ${result?.status}` }
  }
  const entries = new Set()
  for (const rawLine of String(result.stdout ?? '').split('\n')) {
    const line = rawLine.trim().replace(/\\/g, '/')
    if (line) entries.add(line)
  }
  return { ok: true, entries, error: null }
}

/**
 * Read one jar entry's bytes through `bsdtar` (Windows' built-in `tar`), which reads zip archives
 * natively — no hand-written zip parser, and no dependency on the Maven `classes/` directory
 * staying next to the jar.
 *
 * @param {{jarPath: string, entry: string, spawn?: typeof spawnSync}} input
 * @returns {{ok: boolean, hash: string|null, bytes: number, error: string|null}}
 */
export function readJarEntryHash({ jarPath, entry, spawn = spawnSync }) {
  if (!jarPath || !entry) return { ok: false, hash: null, bytes: 0, error: 'no jar path or entry' }
  const result = spawn('tar', ['-xOf', jarPath, entry], {
    timeout: 60_000,
    windowsHide: true,
    maxBuffer: 128 * 1024 * 1024,
  })
  if (result?.error) return { ok: false, hash: null, bytes: 0, error: String(result.error.message ?? result.error) }
  if (result?.status !== 0) {
    const stderr = String(result?.stderr ?? '').trim()
    return { ok: false, hash: null, bytes: 0, error: stderr || `tar exited ${result?.status}` }
  }
  const bytes = Buffer.from(result.stdout ?? Buffer.alloc(0))
  return { ok: true, hash: sha256(bytes), bytes: bytes.length, error: null }
}

/**
 * @param {{file: string, read?: typeof readFileSync}} input
 * @returns {{ok: boolean, hash: string|null, error: string|null}}
 */
export function readFileHash({ file, read = readFileSync }) {
  try {
    return { ok: true, hash: sha256(read(file)), error: null }
  } catch (error) {
    return { ok: false, hash: null, error: String(error?.message ?? error) }
  }
}

/**
 * The source side of the comparison: last **commit** of a path (immutable), plus whether the path
 * currently has uncommitted changes (then there is no commit to trust and the caller falls back to
 * mtime, deliberately the weakest evidence).
 *
 * @param {{projectDir: string, relPath: string, dirtyPaths?: Set<string>|null, run?: typeof spawnSync}} input
 * @returns {{ok: boolean, state: 'clean'|'dirty', commit: string|null, commitTimeMs: number|null, error: string|null}}
 */
export function readPathCommit({ projectDir, relPath, dirtyPaths = null, run = spawnSync }) {
  const path = String(relPath ?? '').replace(/\\/g, '/')
  if (!path) return { ok: false, state: 'clean', commit: null, commitTimeMs: null, error: 'empty path' }
  const result = run('git', ['log', '-1', '--format=%H %ct', '--', path], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  })
  if (result?.error) return { ok: false, state: 'clean', commit: null, commitTimeMs: null, error: String(result.error.message ?? result.error) }
  if (result?.status !== 0) {
    return { ok: false, state: 'clean', commit: null, commitTimeMs: null, error: String(result?.stderr ?? '').trim() || `git log exited ${result?.status}` }
  }
  const text = String(result.stdout ?? '').trim()
  if (text === '') {
    // No commit touches this path: untracked or ignored. Reported as an error so the caller can
    // decide (untracked ⇒ mtime evidence, which is exactly the "no truth available" branch).
    return { ok: false, state: 'clean', commit: null, commitTimeMs: null, error: 'no commit touches this path (untracked)' }
  }
  const [commit, seconds] = text.split(/\s+/)
  const commitTimeMs = Number(seconds) * 1000
  const dirty = dirtyPaths instanceof Set ? dirtyPaths.has(path) : false
  return {
    ok: true,
    state: dirty ? 'dirty' : 'clean',
    commit: commit ?? null,
    commitTimeMs: Number.isFinite(commitTimeMs) ? commitTimeMs : null,
    error: null,
  }
}

/**
 * Uncommitted CP paths, in one `git status` call (`-z` so a path containing spaces stays intact).
 *
 * @param {{projectDir: string, scope?: string, run?: typeof spawnSync}} input
 * @returns {{ok: boolean, paths: Set<string>, error: string|null}}
 */
export function readDirtyPaths({ projectDir, scope = 'packages/control-plane', run = spawnSync }) {
  const result = run('git', ['status', '--porcelain', '-z', '--', scope], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result?.error) return { ok: false, paths: new Set(), error: String(result.error.message ?? result.error) }
  if (result?.status !== 0) {
    return { ok: false, paths: new Set(), error: String(result?.stderr ?? '').trim() || `git status exited ${result?.status}` }
  }
  const paths = new Set()
  for (const record of String(result.stdout ?? '').split('\0')) {
    if (record.length < 4) continue
    // `XY <path>`; a rename record carries a second NUL-separated path that we skip.
    const path = record.slice(3).replace(/\\/g, '/')
    if (path) paths.add(path)
  }
  return { ok: true, paths, error: null }
}

/**
 * The whole decision, as a pure function of (artifact time, newer sources, injected evidence
 * readers). The preflight only prints and scores it.
 *
 * Verdict precedence is deliberately fail-closed: **stale** beats **unverifiable** beats **fresh**.
 *
 * @param {{
 *   artifactTimeMs: number|null,
 *   sources: Array<{path: string, mtimeMs: number}>,
 *   readEntryHash: (entry: string) => {ok: boolean, hash?: string|null, error?: string|null},
 *   readFileHash: (path: string) => {ok: boolean, hash?: string|null, error?: string|null},
 *   readCommitState: (path: string) => {ok: boolean, state?: 'clean'|'dirty', commit?: string|null, commitTimeMs?: number|null, error?: string|null},
 *   hasEntry?: (entry: string) => boolean|null,
 * }} input
 * @returns {{
 *   verdict: 'fresh'|'stale'|'unverifiable',
 *   artifactTimeMs: number|null,
 *   checked: number,
 *   fresh: Array<object>,
 *   stale: Array<object>,
 *   unverifiable: Array<object>,
 * }}
 */
export function decideArtifactFreshness({ artifactTimeMs, sources = [], readEntryHash, readFileHash, readCommitState, hasEntry = () => null }) {
  const artifact = typeof artifactTimeMs === 'number' && Number.isFinite(artifactTimeMs) ? artifactTimeMs : null
  const fresh = []
  const stale = []
  const unverifiable = []

  for (const source of sources) {
    const { kind, entry } = classifyCpSource(source.path)
    const record = { path: source.path, kind, entry, mtimeMs: source.mtimeMs, artifactTimeMs: artifact }

    if (kind === 'resource' && entry) {
      if (hasEntry(entry) === false) {
        stale.push({ ...record, evidence: 'membership', reason: `the artifact does not contain ${entry}` })
        continue
      }
      const artifactSide = readEntryHash(entry)
      if (!artifactSide?.ok) {
        unverifiable.push({ ...record, evidence: null, reason: `artifact entry ${entry} unreadable: ${artifactSide?.error ?? 'no reader'}` })
        continue
      }
      const sourceSide = readFileHash(source.path)
      if (!sourceSide?.ok) {
        unverifiable.push({ ...record, evidence: null, reason: `source unreadable: ${sourceSide?.error ?? 'no reader'}` })
        continue
      }
      if (sourceSide.hash === artifactSide.hash) {
        fresh.push({ ...record, evidence: ARTIFACT_EVIDENCE.sha256, detail: `sha256 ${String(sourceSide.hash).slice(0, 12)} identical` })
      } else {
        stale.push({
          ...record,
          evidence: ARTIFACT_EVIDENCE.sha256,
          detail: `source sha256 ${String(sourceSide.hash).slice(0, 12)} vs artifact ${String(artifactSide.hash).slice(0, 12)}`,
          reason: `content differs from ${entry}`,
        })
      }
      continue
    }

    if (kind === 'java' && entry && hasEntry(entry) === false) {
      // A source with no compiled class in the jar is stale whatever the clocks say.
      stale.push({ ...record, evidence: ARTIFACT_EVIDENCE.membership, reason: `the artifact contains no compiled class (${entry})` })
      continue
    }

    if (artifact === null) {
      unverifiable.push({ ...record, evidence: null, reason: 'artifact write time unknown' })
      continue
    }
    const commit = readCommitState(source.path)
    if (!commit?.ok) {
      const untracked = String(commit?.error ?? '').includes('untracked')
      if (untracked) {
        if (source.mtimeMs > artifact) {
          stale.push({ ...record, evidence: ARTIFACT_EVIDENCE.mtime, reason: 'untracked source written after the artifact' })
        } else {
          unverifiable.push({ ...record, evidence: null, reason: 'untracked source: no commit can prove what the artifact carries' })
        }
      } else {
        unverifiable.push({ ...record, evidence: null, reason: `cannot resolve the last commit: ${commit?.error ?? 'no reader'}` })
      }
      continue
    }
    if (commit.state === 'dirty') {
      if (source.mtimeMs > artifact) {
        stale.push({ ...record, evidence: ARTIFACT_EVIDENCE.mtime, reason: 'uncommitted edit is newer than the artifact' })
      } else {
        unverifiable.push({ ...record, evidence: null, reason: 'uncommitted edit older than the artifact; it may or may not be inside it' })
      }
      continue
    }
    const commitTimeMs = commit.commitTimeMs
    if (typeof commitTimeMs !== 'number' || !Number.isFinite(commitTimeMs)) {
      unverifiable.push({ ...record, evidence: null, reason: 'last commit has no usable committer time' })
      continue
    }
    if (commitTimeMs > artifact) {
      stale.push({
        ...record,
        evidence: ARTIFACT_EVIDENCE.commitTime,
        commit: commit.commit ?? null,
        detail: `last commit ${new Date(commitTimeMs).toISOString()} is ${Math.round((commitTimeMs - artifact) / 1000)}s newer than the artifact`,
        reason: 'source content is newer than the artifact',
      })
    } else {
      fresh.push({
        ...record,
        evidence: ARTIFACT_EVIDENCE.commitTime,
        commit: commit.commit ?? null,
        detail: `last commit ${new Date(commitTimeMs).toISOString()} predates the artifact (mtime is checkout noise)`,
      })
    }
  }

  const verdict = stale.length > 0 ? 'stale' : unverifiable.length > 0 ? 'unverifiable' : 'fresh'
  return { verdict, artifactTimeMs: artifact, checked: sources.length, fresh, stale, unverifiable }
}
