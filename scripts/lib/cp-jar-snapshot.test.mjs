/**
 * task-42: the jar-state snapshot is the single sample the boot plan and the window gate share.
 *
 * Every case here is pure node (tmp dirs + fake git): no stack, no Docker, no Maven. The real-stack
 * green run (J1) is a separate, Lead-scheduled window — see
 * `internal/A03-xihe/evidence/2026-11-22-e2e-host-jar-snapshot/README.md`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SNAPSHOT_MAX_AGE_MS,
  JAR_SNAPSHOT_FILE_NAME,
  JAR_SNAPSHOT_SCHEMA,
  buildJarSnapshot,
  decideSharedSample,
  describeSnapshotSource,
  loadJarSnapshot,
  normalizeTargetDir,
  sampleCpJarBytes,
  sampleFromSnapshot,
  snapshotId,
  writeJarSnapshotFile,
} from './cp-jar-snapshot.mjs'
import { evaluateSidecar, readSidecar, resolveArtifactTruth, sha256File, sidecarPathFor, writeSidecarForJar } from './cp-jar-sidecar.mjs'

const SNAP_COMMIT = 'a'.repeat(40)
const OTHER_COMMIT = 'b'.repeat(40)
const JAR_BYTES = Buffer.from('the fat jar bytes, small on purpose\n', 'utf8')

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * A git stub whose HEAD tree is switchable: `ls-tree` output is hashed for the tree id, so two
 * different listings model "the sidecar describes an older CP tree than HEAD" — the exact condition
 * that used to be visible only to the preflight, i.e. the self-heal branch's blind spot.
 */
function fakeGit({ treeMode = 'same', headFails = false, commit = SNAP_COMMIT } = {}) {
  const listing = (marker) => `100644 blob 1111111111111111111111111111111111111111\tpackages/control-plane/src/main/java/${marker}.java\n`
  return function run(command, args) {
    assert.equal(command, 'git', 'the fake only answers git')
    if (args[0] === 'rev-parse') {
      return headFails ? { status: 128, stdout: '', stderr: 'not a repository' } : { status: 0, stdout: `${commit}\n`, stderr: '' }
    }
    if (args[0] === 'status') return { status: 0, stdout: '', stderr: '' }
    if (args[0] === 'ls-tree') {
      return { status: 0, stdout: Buffer.from(listing(treeMode === 'moved' ? 'Moved' : 'Same'), 'utf8'), stderr: '' }
    }
    if (args[0] === 'diff') return { status: 0, stdout: 'packages/control-plane/src/main/java/Moved.java\n', stderr: '' }
    return { status: 1, stdout: '', stderr: `unexpected git ${args[0]}` }
  }
}

/** Write a jar and the pair that describes it, exactly as `stampCpArtifact` would (minus the in-jar stamp). */
function pairedJar({ dir, treeMode = 'same', commit = SNAP_COMMIT } = {}) {
  const jarPath = join(dir, 'control-plane-0.1.0.jar')
  writeFileSync(jarPath, JAR_BYTES)
  const jarMtimeMs = statSync(jarPath).mtimeMs
  const written = writeSidecarForJar({
    projectDir: dir,
    jarPath,
    writtenBy: 'scripts/e2e-host.mjs',
    run: fakeGit({ treeMode, commit }),
    // Pin the clock to the jar's mtime so the write-lag guard never depends on test speed.
    now: () => jarMtimeMs,
  })
  assert.equal(written.ok, true, written.error ?? '')
  return { jarPath, sidecar: written.data }
}

/** The in-repo sampler shape (`resolveCpJarState` builds the same record). */
function jarState({ dir, targetDir = dir }) {
  const jarPath = join(targetDir, 'control-plane-0.1.0.jar')
  const stat = statSync(jarPath)
  const jar = { path: jarPath, name: stat.name ?? 'control-plane-0.1.0.jar', mtimeMs: stat.mtimeMs }
  const sample = sampleCpJarBytes({ jarPath, readSidecar, sha256File })
  const read = sample.sidecarRead
  const identity = read.state === 'ok' && sample.jarHash.ok
    ? sample.jarHash.sha256 === read.data.jarSha256 && jar.name === read.data.jarName
    : null
  return {
    cpDir: dir,
    jar,
    newestSource: { path: join(dir, 'src', 'main', 'App.java'), mtimeMs: jar.mtimeMs - 1000 },
    sidecar: { state: read.state, file: read.file, data: read.data, identity, reason: 'test sampler' },
    sample,
  }
}

function snapshotFor(dir, extra = {}) {
  return buildJarSnapshot({ state: jarState({ dir }), targetDir: dir, runId: 'host-1-abc', seq: 1, sampledBy: 'boot-plan', ...extra })
}

test('task-42: the sample id is observable, stable and safe to grep', () => {
  assert.equal(snapshotId({ runId: 'host-1700000000-ff00', seq: 2 }), 'snap-host-1700000000-ff00-2')
  // Junk in the run id cannot smuggle a space/newline into a log line or a filename.
  assert.equal(snapshotId({ runId: 'a b\n../x' }), 'snap-abx-1')
  assert.equal(snapshotId({ runId: 'x', seq: 0 }), 'snap-x-1', 'a bad seq degrades to 1, never to snap-x-0')
})

test('task-42: every file-level field is a bare name (only the build dir itself is absolute)', () => {
  const dir = tempDir('xihe-jar-snapshot-paths-')
  try {
    pairedJar({ dir })
    const snapshot = snapshotFor(dir)
    // `targetDir` is the one absolute value the record carries, and on purpose: it is what the gate
    // compares to refuse another build dir's sample. Everything *inside* that dir travels by name, so
    // the log/record never repeats a machine path for each artifact.
    const fileLevel = [snapshot.jar.name, snapshot.sample.sidecar.name]
    for (const value of fileLevel) {
      assert.ok(!/[\\/]/u.test(value), `a file-level field must not carry a directory: ${value}`)
      assert.ok(!value.includes(dir), `a file-level field must not embed the build dir: ${value}`)
    }
    assert.ok(!JSON.stringify(snapshot.sample.sidecar.data).includes(dir), 'the manifest is stored as read, path-free by construction')
    assert.equal(snapshot.schema, JAR_SNAPSHOT_SCHEMA)
    assert.equal(snapshot.jar.name, 'control-plane-0.1.0.jar')
    assert.equal(snapshot.jarSha256, sha256(JAR_BYTES))
    assert.equal(snapshot.sample.sidecar.name, 'control-plane-0.1.0.jar.buildinfo.json')
    assert.equal(snapshot.targetDir, dir.replaceAll('\\', '/'), 'the build dir is recorded so a foreign sample can be refused')
    assert.match(describeSnapshotSource({ id: snapshot.id, jarName: snapshot.jar.name, sampledAt: snapshot.sampledAt, source: 'boot-plan' }),
      /^shared sample snap-host-1-abc-1 jar=control-plane-0\.1\.0\.jar \d+s old source=boot-plan$/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-42: the record round-trips into the SAME reader input, so boot plan and gate judge one read', () => {
  const dir = tempDir('xihe-jar-snapshot-same-')
  try {
    const { jarPath, sidecar } = pairedJar({ dir })
    const snapshot = snapshotFor(dir)
    const reused = sampleFromSnapshot({ snapshot, targetDir: dir })
    // The pair is byte-for-byte what the sampler took: same hash, same manifest content.
    assert.equal(reused.jarHash.sha256, sidecar.jarSha256)
    assert.deepEqual(reused.sidecarRead.data, sidecar)
    const run = fakeGit()
    const direct = evaluateSidecar({ jarPath, projectDir: dir, run })
    const shared = evaluateSidecar({ jarPath, projectDir: dir, run, sample: reused })
    assert.equal(shared.state, direct.state, 'the handed-in sample must not change the reader verdict')
    assert.equal(shared.state, 'fresh')
    // J3 (structural): reuse means **no second read**. A jar that is unreadable on disk while the sample
    // still holds its hash proves the reader consumed the snapshot, not the filesystem.
    const unreadable = { ...reused, sidecarRead: reused.sidecarRead, jarHash: { ok: false, sha256: null, bytes: null, error: 'injected' } }
    assert.equal(evaluateSidecar({ jarPath, projectDir: dir, run, sample: unreadable }).state, 'invalid')
    writeFileSync(jarPath, Buffer.from('jar replaced behind the sample\n', 'utf8'))
    const fromSample = evaluateSidecar({ jarPath, projectDir: dir, run, sample: reused })
    const fromDisk = evaluateSidecar({ jarPath, projectDir: dir, run })
    assert.equal(fromSample.state, 'fresh', 'the shared sample still describes the artifact that was sampled')
    assert.equal(fromDisk.state, 'identity-mismatch', 'a fresh read would have seen the substitution — which is why the handoff is verified')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-42 J2: a jar changed behind its sidecar is still identity-mismatch through the snapshot', () => {
  // The negative control for this card: sharing one read must not soften the reader. If a jar replaced
  // after the stamp ever came back `fresh`, the "fix" would be a widened criterion, not a shared sample.
  const dir = tempDir('xihe-jar-snapshot-mismatch-')
  try {
    const { jarPath } = pairedJar({ dir })
    writeFileSync(jarPath, Buffer.from('a different jar, same file name\n', 'utf8'))
    const snapshot = snapshotFor(dir)
    const verdict = decideSharedSample({ snapshot, targetDir: dir, projectDir: dir, evaluateSidecar, resolveArtifactTruth, run: fakeGit() })
    assert.equal(verdict.verdict, 'stale')
    assert.equal(verdict.blocking, 'artifact-truth', 'identity mismatch must stay the non-deferrable scope')
    const truth = resolveArtifactTruth({ sidecar: evaluateSidecar({ jarPath, projectDir: dir, run: fakeGit() }), runFallback: () => null })
    assert.equal(truth.blocking, 'artifact-truth')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-42 J1 reachability: HEAD moved past the sidecar tree ⇒ the shared sample says stale `build`, not fresh', () => {
  // This is the condition that used to be visible **only** to the preflight (boot plan's cheap check
  // reads mtime + identity, both green). `decideSharedSample` runs the reader's state machine over the
  // same sample, so the self-heal branch fires on content instead of on a read gap.
  const dir = tempDir('xihe-jar-snapshot-moved-')
  try {
    pairedJar({ dir, treeMode: 'same' })
    const snapshot = snapshotFor(dir)
    // Same jar/manifest; HEAD's tree has moved on.
    const verdict = decideSharedSample({
      snapshot,
      targetDir: dir,
      projectDir: dir,
      evaluateSidecar,
      resolveArtifactTruth,
      run: fakeGit({ treeMode: 'moved' }),
    })
    assert.equal(verdict.verdict, 'stale')
    assert.equal(verdict.blocking, 'build', 'a tree that moved is the deferrable scope (the rebuild is the documented cure)')
    assert.equal(verdict.state, 'stale')
    // …while the cheap sampler still calls it fine: that is precisely the old blind spot.
    assert.equal(snapshot.identity.identity, true)
    assert.ok(snapshot.newestSourceMtimeMs <= snapshot.jar.mtimeMs)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-42: `missing`/`degraded` answer `fallback` — never a silent fresh (the gate keeps deciding)', () => {
  const dir = tempDir('xihe-jar-snapshot-fallback-')
  try {
    const jarPath = join(dir, 'control-plane-0.1.0.jar')
    writeFileSync(jarPath, JAR_BYTES)
    const snapshot = snapshotFor(dir)
    assert.equal(snapshot.sample.sidecar.state, 'missing')
    const verdict = decideSharedSample({ snapshot, targetDir: dir, projectDir: dir, evaluateSidecar, resolveArtifactTruth, run: fakeGit() })
    assert.equal(verdict.verdict, 'fallback')
    assert.equal(verdict.blocking, null)
    assert.match(verdict.reason, /left to the gate/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-42: the handoff survives a write/read round trip through the run dir', () => {
  const dir = tempDir('xihe-jar-snapshot-file-')
  try {
    pairedJar({ dir })
    const snapshot = snapshotFor(dir)
    const file = join(dir, 'logs', JAR_SNAPSHOT_FILE_NAME)
    const written = writeJarSnapshotFile({ file, snapshot })
    assert.equal(written.ok, true, written.error ?? '')
    assert.ok(readFileSync(file, 'utf8').includes(snapshot.id))
    const loaded = loadJarSnapshot({ file, targetDir: dir })
    assert.equal(loaded.verdict, 'ok')
    assert.equal(loaded.id, snapshot.id, 'the gate names the same sample the boot plan took')
    // Path separators are cosmetic: the two sides must still agree on which build dir was sampled.
    assert.equal(loadJarSnapshot({ file, targetDir: dir.replaceAll('/', '\\') }).verdict, 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-42 J4: an expired snapshot is refused, and a bad handoff is never quietly re-read as green', () => {
  const dir = tempDir('xihe-jar-snapshot-expired-')
  try {
    pairedJar({ dir })
    const snapshot = snapshotFor(dir)
    const file = join(dir, JAR_SNAPSHOT_FILE_NAME)
    assert.equal(writeJarSnapshotFile({ file, snapshot }).ok, true)
    const nowMs = Date.parse(snapshot.sampledAt)

    const insideAge = loadJarSnapshot({ file, targetDir: dir, now: () => nowMs + DEFAULT_SNAPSHOT_MAX_AGE_MS - 1000 })
    assert.equal(insideAge.verdict, 'ok')
    const expired = loadJarSnapshot({ file, targetDir: dir, now: () => nowMs + DEFAULT_SNAPSHOT_MAX_AGE_MS + 60_000 })
    assert.equal(expired.verdict, 'expired', 'a sample this old does not vouch for the window')
    assert.match(expired.reason, /older than the gate will accept/u)

    // A sample from another build dir / another run must not describe this one.
    const other = loadJarSnapshot({ file, targetDir: join(dir, 'elsewhere') })
    assert.equal(other.verdict, 'foreignTarget')
    // The jar was replaced after the sample: refuse, do not re-sample and call it the same read.
    utimesSync(join(dir, 'control-plane-0.1.0.jar'), (Date.now() + 5_000) / 1000, (Date.now() + 5_000) / 1000)
    const substituted = loadJarSnapshot({ file, targetDir: dir, now: () => nowMs + 1000 })
    assert.equal(substituted.verdict, 'substituted')
    assert.match(substituted.reason, /changed after the sample/u)
    // A record that cannot be parsed is unusable; a missing file is the standalone-preflight case.
    writeFileSync(file, '{not json')
    assert.equal(loadJarSnapshot({ file, targetDir: dir }).verdict, 'unusable')
    assert.equal(loadJarSnapshot({ file: join(dir, 'nope.json'), targetDir: dir }).verdict, 'absent')
    assert.equal(loadJarSnapshot({ file: null, targetDir: dir }).verdict, 'absent')
    assert.match(normalizeTargetDir(`${dir}/`), /^[a-z]:\/|^\//u, 'normalisation lowercases and trims for comparison only')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task-42: a sample with no jar hands back nothing (the gate reads the artifact itself)', () => {
  const snapshot = buildJarSnapshot({
    state: { jar: null, newestSource: { path: 'x', mtimeMs: 1 }, sidecar: { state: 'missing', identity: null }, sample: { sidecarRead: null, jarHash: null } },
    targetDir: 'C:/xihe-build/e2e',
    runId: 'host-2',
  })
  assert.equal(snapshot.jar, null)
  assert.equal(snapshot.sample, null, 'no jar ⇒ no reusable pair, so `sampleFromSnapshot` cannot fabricate one')
  assert.equal(sampleFromSnapshot({ snapshot, targetDir: 'C:/xihe-build/e2e' }), null)
  assert.equal(snapshot.hashError, 'the jar was never sampled (no jar in the build dir)')
  const verdict = decideSharedSample({ snapshot, targetDir: 'C:/xihe-build/e2e', projectDir: 'C:/proj', evaluateSidecar, resolveArtifactTruth })
  assert.equal(verdict.verdict, 'absent')
})

test('task-42: the manifest content in the record is the manifest on disk (identity travels with the sample)', () => {
  const dir = tempDir('xihe-jar-snapshot-manifest-')
  try {
    const { jarPath, sidecar } = pairedJar({ dir, commit: OTHER_COMMIT })
    const snapshot = snapshotFor(dir)
    assert.deepEqual(snapshot.sample.sidecar.data, JSON.parse(readFileSync(sidecarPathFor(jarPath), 'utf8')))
    assert.equal(snapshot.sample.sidecar.data.commit, sidecar.commit)
    // The reader can prove identity from the record alone — the jar is never re-hashed.
    assert.equal(snapshot.jarSha256, sidecar.jarSha256)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
