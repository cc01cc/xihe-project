import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ARTIFACT_EVIDENCE,
  classifyCpSource,
  collectSourcesNewerThan,
  decideArtifactFreshness,
  listJarEntries,
  readDirtyPaths,
  readFileHash,
  readJarEntryHash,
  readPathCommit,
  sha256,
} from './e2e-build-artifact.mjs'

const ARTIFACT = 1_700_000_000_000
const NEWER = ARTIFACT + 60_000
const OLDER = ARTIFACT - 60_000

/** Readers that always succeed with the given hashes, so each test only stages what it asserts. */
function readers({ entry = {}, file = {}, commit = {} } = {}) {
  return {
    readEntryHash: (name) => entry[name] ?? { ok: false, hash: null, error: 'no entry' },
    readFileHash: (path) => file[path] ?? { ok: false, hash: null, error: 'no file' },
    readCommitState: (path) => commit[path] ?? { ok: false, error: 'no reader' },
  }
}

const clean = (commitTimeMs, commit = 'deadbeef') => ({ ok: true, state: 'clean', commit, commitTimeMs, error: null })

test('T1 classifyCpSource: resources map verbatim, java maps to class, pom has no entry', () => {
  assert.deepEqual(classifyCpSource('src/main/resources/db/migration/V1.sql'), {
    kind: 'resource',
    entry: 'BOOT-INF/classes/db/migration/V1.sql',
  })
  assert.deepEqual(classifyCpSource('src/main/java/com/cc01cc/p/xihe/cp/Plugin.java'), {
    kind: 'java',
    entry: 'BOOT-INF/classes/com/cc01cc/p/xihe/cp/Plugin.class',
  })
  assert.deepEqual(classifyCpSource('pom.xml'), { kind: 'pom', entry: null })
  assert.deepEqual(classifyCpSource('src/main/other.txt'), { kind: 'other', entry: null })
  // Backslash input (Windows callers) must classify identically.
  assert.deepEqual(
    classifyCpSource('src\\main\\resources\\application.properties'),
    { kind: 'resource', entry: 'BOOT-INF/classes/application.properties' },
  )
  // Repo-relative paths (what git and the preflight walker emit) must classify like package paths.
  assert.deepEqual(
    classifyCpSource('packages/control-plane/src/main/resources/db/migration/V1.sql'),
    { kind: 'resource', entry: 'BOOT-INF/classes/db/migration/V1.sql' },
  )
  assert.deepEqual(
    classifyCpSource('packages/control-plane/src/main/java/com/cc01cc/p/xihe/cp/Plugin.java'),
    { kind: 'java', entry: 'BOOT-INF/classes/com/cc01cc/p/xihe/cp/Plugin.class' },
  )
  assert.deepEqual(classifyCpSource('packages/control-plane/pom.xml'), { kind: 'pom', entry: null })
})

test('T2 resource with identical bytes is FRESH even though its mtime is newer than the jar', () => {
  // This is the (a) case from the card: checkout rewrote the mtime, content unchanged.
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path: 'src/main/resources/db/migration/V135__plan0691_plugins.sql', mtimeMs: NEWER }],
    ...readers({
      entry: { 'BOOT-INF/classes/db/migration/V135__plan0691_plugins.sql': { ok: true, hash: 'a'.repeat(64) } },
      file: { 'src/main/resources/db/migration/V135__plan0691_plugins.sql': { ok: true, hash: 'a'.repeat(64) } },
    }),
  })
  assert.equal(verdict.verdict, 'fresh')
  assert.equal(verdict.fresh.length, 1)
  assert.equal(verdict.fresh[0].evidence, ARTIFACT_EVIDENCE.sha256)
})

test('T3 resource whose bytes differ from the jar is STALE (blocking semantics kept)', () => {
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path: 'src/main/resources/application.properties', mtimeMs: NEWER }],
    ...readers({
      entry: { 'BOOT-INF/classes/application.properties': { ok: true, hash: 'b'.repeat(64) } },
      file: { 'src/main/resources/application.properties': { ok: true, hash: 'c'.repeat(64) } },
    }),
  })
  assert.equal(verdict.verdict, 'stale')
  assert.equal(verdict.stale[0].evidence, ARTIFACT_EVIDENCE.sha256)
  assert.match(verdict.stale[0].reason, /content differs/)
})

test('T4 unreadable/absent artifact entry is UNVERIFIABLE, never fresh and never stale', () => {
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path: 'src/main/resources/application.properties', mtimeMs: NEWER }],
    ...readers({ file: { 'src/main/resources/application.properties': { ok: true, hash: 'c'.repeat(64) } } }),
  })
  assert.equal(verdict.verdict, 'unverifiable')
  assert.equal(verdict.stale.length, 0)
  assert.equal(verdict.fresh.length, 0)
  assert.match(verdict.unverifiable[0].reason, /unreadable/)
})

test('T5 unreadable source file is UNVERIFIABLE (spawn/read failures never become a green)', () => {
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path: 'src/main/resources/application.properties', mtimeMs: NEWER }],
    ...readers({ entry: { 'BOOT-INF/classes/application.properties': { ok: true, hash: 'c'.repeat(64) } } }),
  })
  assert.equal(verdict.verdict, 'unverifiable')
  assert.match(verdict.unverifiable[0].reason, /source unreadable/)
})

test('T6 java source whose last commit predates the jar is FRESH (mtime is checkout noise)', () => {
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path: 'src/main/java/com/cc01cc/p/xihe/cp/Plugin.java', mtimeMs: NEWER }],
    ...readers({ commit: { 'src/main/java/com/cc01cc/p/xihe/cp/Plugin.java': clean(OLDER) } }),
  })
  assert.equal(verdict.verdict, 'fresh')
  assert.equal(verdict.fresh[0].evidence, ARTIFACT_EVIDENCE.commitTime)
  assert.match(verdict.fresh[0].detail, /checkout noise/)
})

test('T7 java source committed after the jar is STALE (the (b) case)', () => {
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path: 'src/main/java/com/cc01cc/p/xihe/cp/Plugin.java', mtimeMs: OLDER }],
    ...readers({ commit: { 'src/main/java/com/cc01cc/p/xihe/cp/Plugin.java': clean(NEWER) } }),
  })
  assert.equal(verdict.verdict, 'stale')
  assert.equal(verdict.stale[0].evidence, ARTIFACT_EVIDENCE.commitTime)
  assert.equal(verdict.stale[0].commit, 'deadbeef')
})

test('T8 boundary: a commit at exactly the artifact time is fresh, 1 ms later is stale', () => {
  const path = 'pom.xml'
  const at = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path, mtimeMs: NEWER }],
    ...readers({ commit: { [path]: clean(ARTIFACT) } }),
  })
  assert.equal(at.verdict, 'fresh')
  const later = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path, mtimeMs: NEWER }],
    ...readers({ commit: { [path]: clean(ARTIFACT + 1) } }),
  })
  assert.equal(later.verdict, 'stale')
})

test('T9 dirty source newer than the jar is STALE; an older dirty edit is UNVERIFIABLE', () => {
  const path = 'src/main/java/com/cc01cc/p/xihe/cp/Plugin.java'
  const dirty = (mtimeMs) => ({ ok: true, state: 'dirty', commit: 'deadbeef', commitTimeMs: OLDER, error: null })
  const newer = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path, mtimeMs: NEWER }],
    ...readers({ commit: { [path]: dirty(NEWER) } }),
  })
  assert.equal(newer.verdict, 'stale')
  assert.equal(newer.stale[0].evidence, ARTIFACT_EVIDENCE.mtime)
  const older = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path, mtimeMs: OLDER }],
    ...readers({ commit: { [path]: dirty(OLDER) } }),
  })
  assert.equal(older.verdict, 'unverifiable')
  assert.match(older.unverifiable[0].reason, /uncommitted edit older/)
})

test('T10 untracked source newer than the jar is STALE; an older one is UNVERIFIABLE', () => {
  const path = 'src/main/java/com/cc01cc/p/xihe/cp/Scratch.java'
  const untracked = { ok: false, error: 'no commit touches this path (untracked)' }
  const newer = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path, mtimeMs: NEWER }],
    ...readers({ commit: { [path]: untracked } }),
  })
  assert.equal(newer.verdict, 'stale')
  assert.match(newer.stale[0].reason, /untracked source written after/)
  const older = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path, mtimeMs: OLDER }],
    ...readers({ commit: { [path]: untracked } }),
  })
  assert.equal(older.verdict, 'unverifiable')
})

test('T11 git failure is UNVERIFIABLE and can never be scored as fresh', () => {
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path: 'src/main/java/com/cc01cc/p/xihe/cp/Plugin.java', mtimeMs: OLDER }],
    ...readers({ commit: { 'src/main/java/com/cc01cc/p/xihe/cp/Plugin.java': { ok: false, error: 'git not found' } } }),
  })
  assert.equal(verdict.verdict, 'unverifiable')
  assert.equal(verdict.fresh.length, 0)
  assert.match(verdict.unverifiable[0].reason, /cannot resolve the last commit/)
})

test('T12 no newer sources at all ⇒ fresh with checked=0', () => {
  const verdict = decideArtifactFreshness({ artifactTimeMs: ARTIFACT, sources: [], ...readers() })
  assert.equal(verdict.verdict, 'fresh')
  assert.equal(verdict.checked, 0)
})

test('T13 unknown artifact time: resources still decide by hash, everything else is UNVERIFIABLE', () => {
  const resource = 'src/main/resources/application.properties'
  const java = 'src/main/java/com/cc01cc/p/xihe/cp/Plugin.java'
  const verdict = decideArtifactFreshness({
    artifactTimeMs: null,
    sources: [
      { path: resource, mtimeMs: NEWER },
      { path: java, mtimeMs: NEWER },
    ],
    ...readers({
      entry: { 'BOOT-INF/classes/application.properties': { ok: true, hash: 'a'.repeat(64) } },
      file: { [resource]: { ok: true, hash: 'a'.repeat(64) } },
      commit: { [java]: clean(OLDER) },
    }),
  })
  assert.equal(verdict.verdict, 'unverifiable')
  assert.equal(verdict.fresh.length, 1)
  assert.equal(verdict.unverifiable.length, 1)
  assert.match(verdict.unverifiable[0].reason, /artifact write time unknown/)
})

test('T14 precedence: stale beats unverifiable beats fresh', () => {
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [
      { path: 'src/main/resources/a.properties', mtimeMs: NEWER },
      { path: 'src/main/resources/b.properties', mtimeMs: NEWER },
      { path: 'src/main/resources/c.properties', mtimeMs: NEWER },
    ],
    ...readers({
      entry: {
        'BOOT-INF/classes/a.properties': { ok: true, hash: 'a'.repeat(64) },
        'BOOT-INF/classes/b.properties': { ok: true, hash: 'e'.repeat(64) },
      },
      file: {
        'src/main/resources/a.properties': { ok: true, hash: 'a'.repeat(64) },
        'src/main/resources/b.properties': { ok: true, hash: 'd'.repeat(64) },
        'src/main/resources/c.properties': { ok: true, hash: 'c'.repeat(64) },
      },
    }),
  })
  assert.equal(verdict.verdict, 'stale')
  assert.equal(verdict.stale.length, 1)
  assert.equal(verdict.unverifiable.length, 1)
  assert.equal(verdict.fresh.length, 1)
})

test('T15 sha256 is stable and lowercase hex', () => {
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256(Buffer.alloc(0)), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('T16 readJarEntryHash: same bytes through tar hash identically; failures stay failures', () => {
  const spawnOk = () => ({ status: 0, stdout: Buffer.from('hello\n'), stderr: Buffer.alloc(0) })
  assert.deepEqual(readJarEntryHash({ jarPath: 'j.jar', entry: 'e', spawn: spawnOk }), {
    ok: true,
    hash: sha256('hello\n'),
    bytes: 6,
    error: null,
  })
  const spawnMissing = () => ({ status: null, stdout: null, stderr: null, error: new Error('spawn tar ENOENT') })
  const missing = readJarEntryHash({ jarPath: 'j.jar', entry: 'e', spawn: spawnMissing })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /ENOENT/)
  const spawnBad = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('tar: entry not found') })
  const bad = readJarEntryHash({ jarPath: 'j.jar', entry: 'e', spawn: spawnBad })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /entry not found/)
  assert.equal(readJarEntryHash({ jarPath: '', entry: 'e' }).ok, false)
})

test('T17 readFileHash: missing files are reported, not thrown', () => {
  const ok = readFileHash({ file: 'ignored', read: () => Buffer.from('x') })
  assert.equal(ok.ok, true)
  const bad = readFileHash({
    file: 'ignored',
    read: () => {
      throw new Error('ENOENT: no such file')
    },
  })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /ENOENT/)
})

test('T18 readPathCommit: parses `sha ct`, flags dirty paths, reports untracked as an error', () => {
  const run = (program, args) => {
    assert.equal(program, 'git')
    assert.deepEqual(args.slice(0, 3), ['log', '-1', '--format=%H %ct'])
    return { status: 0, stdout: 'abcdef1234567 1700000000\n', stderr: '' }
  }
  const path = 'src/main/java/A.java'
  const cleanState = readPathCommit({ projectDir: 'p', relPath: path, run })
  assert.deepEqual(cleanState, { ok: true, state: 'clean', commit: 'abcdef1234567', commitTimeMs: 1_700_000_000_000, error: null })
  const dirtyState = readPathCommit({ projectDir: 'p', relPath: path, dirtyPaths: new Set([path]), run })
  assert.equal(dirtyState.state, 'dirty')

  const empty = readPathCommit({ projectDir: 'p', relPath: path, run: () => ({ status: 0, stdout: '\n', stderr: '' }) })
  assert.equal(empty.ok, false)
  assert.match(empty.error, /untracked/)
  const failed = readPathCommit({ projectDir: 'p', relPath: path, run: () => ({ status: 128, stdout: '', stderr: 'not a git repository' }) })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /not a git repository/)
})

test('T19 readDirtyPaths: parses -z porcelain records; failure is reported as a failure', () => {
  const run = () => ({
    status: 0,
    stdout: ' M packages/control-plane/src/main/java/A.java\0?? packages/control-plane/notes.txt\0',
    stderr: '',
  })
  const parsed = readDirtyPaths({ projectDir: 'p', run })
  assert.equal(parsed.ok, true)
  assert.deepEqual([...parsed.paths].sort(), [
    'packages/control-plane/notes.txt',
    'packages/control-plane/src/main/java/A.java',
  ])
  const failed = readDirtyPaths({ projectDir: 'p', run: () => ({ status: 128, stdout: '', stderr: 'boom' }) })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /boom/)
})

test('T21 listJarEntries: parses `tar -tf` names; failures are reported, never an empty success', () => {
  const ok = listJarEntries({
    jarPath: 'j.jar',
    spawn: () => ({ status: 0, stdout: 'BOOT-INF/classes/a.properties\r\nBOOT-INF/classes/db/V1.sql\n\n', stderr: '' }),
  })
  assert.equal(ok.ok, true)
  assert.deepEqual([...ok.entries].sort(), ['BOOT-INF/classes/a.properties', 'BOOT-INF/classes/db/V1.sql'])
  const failed = listJarEntries({ jarPath: 'j.jar', spawn: () => ({ status: 1, stdout: '', stderr: 'not a zip' }) })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /not a zip/)
  assert.equal(listJarEntries({ jarPath: '', spawn: () => ({ status: 0, stdout: '', stderr: '' }) }).ok, false)
})

test('T22 a resource that is absent from the jar is STALE without needing its hash', () => {
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path: 'src/main/resources/db/migration/V136__probe.sql', mtimeMs: NEWER }],
    ...readers({
      file: { 'src/main/resources/db/migration/V136__probe.sql': { ok: true, hash: 'a'.repeat(64) } },
    }),
    hasEntry: () => false,
  })
  assert.equal(verdict.verdict, 'stale')
  assert.equal(verdict.stale[0].evidence, ARTIFACT_EVIDENCE.membership)
  assert.match(verdict.stale[0].reason, /does not contain/)
})

test('T23 a java source with no compiled class in the jar is STALE regardless of commit times', () => {
  const path = 'src/main/java/com/cc01cc/p/xihe/cp/NewThing.java'
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path, mtimeMs: OLDER }],
    ...readers({ commit: { [path]: clean(OLDER) } }),
    hasEntry: () => false,
  })
  assert.equal(verdict.verdict, 'stale')
  assert.match(verdict.stale[0].reason, /no compiled class/)
})

test('T24 unknown membership (jar unlistable) stays UNVERIFIABLE, not stale and not fresh', () => {
  const path = 'src/main/java/com/cc01cc/p/xihe/cp/NewThing.java'
  const verdict = decideArtifactFreshness({
    artifactTimeMs: ARTIFACT,
    sources: [{ path, mtimeMs: OLDER }],
    ...readers({ commit: { [path]: { ok: false, error: 'git not found' } } }),
    hasEntry: () => null,
  })
  assert.equal(verdict.verdict, 'unverifiable')
})

test('T20 collectSourcesNewerThan: only newer files, prefixed POSIX paths, newest first, skips target/', () => {
  const root = mkdtempSync(join(tmpdir(), 'bl477-artifact-'))
  mkdirSync(join(root, 'src', 'main', 'resources'), { recursive: true })
  mkdirSync(join(root, 'target', 'classes'), { recursive: true })
  const older = new Date(ARTIFACT - 60_000)
  const newer = new Date(ARTIFACT + 60_000)
  writeFileSync(join(root, 'src', 'main', 'resources', 'old.txt'), 'old')
  writeFileSync(join(root, 'src', 'main', 'resources', 'new.txt'), 'new')
  writeFileSync(join(root, 'target', 'classes', 'new.txt'), 'new')
  utimesSync(join(root, 'src', 'main', 'resources', 'old.txt'), older, older)
  utimesSync(join(root, 'src', 'main', 'resources', 'new.txt'), newer, newer)
  utimesSync(join(root, 'target', 'classes', 'new.txt'), newer, newer)
  const found = collectSourcesNewerThan({ root, sinceMs: ARTIFACT, prefix: 'packages/control-plane' })
  assert.equal(found.length, 1)
  assert.equal(found[0].path, 'packages/control-plane/src/main/resources/new.txt')
  assert.ok(found[0].mtimeMs > ARTIFACT)
})
