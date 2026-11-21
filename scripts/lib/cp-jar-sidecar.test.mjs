/**
 * BL-477 / task-90: unit tests for the CP jar sidecar (fingerprint writer + reader priority).
 *
 * The three axes the card requires are all here:
 * - manifest present but `jarSha256` mismatch ⇒ `stale` **and** mapped to the non-deferrable scope
 * - manifest missing ⇒ the task-84 content path is used unchanged (the fallback is called exactly
 *   once and its result is passed through untouched)
 * - neither usable ⇒ `unverifiable` (fail-closed)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_MAX_FUTURE_MTIME_MS,
  DEFAULT_MAX_WRITE_LAG_MS,
  DEFAULT_SOURCE_SCOPE,
  SIDECAR_SCHEMA,
  buildSidecar,
  computeSourceTreeSha256,
  countChangedSources,
  evaluateSidecar,
  parseSidecar,
  readSidecar,
  resolveArtifactTruth,
  sha256File,
  sha256Hex,
  sidecarFileName,
  sidecarPathFor,
  sourceTreeSha256Command,
  writeSidecarAtomic,
  writeSidecarForJar,
  verifyJarRepackaged,
} from './cp-jar-sidecar.mjs';

const TREE_TEXT = '100644 blob aaaa\tpackages/control-plane/pom.xml\n100644 blob bbbb\tpackages/control-plane/src/main/resources/application.properties\n';
const TREE_SHA = createHash('sha256').update(Buffer.from(TREE_TEXT, 'utf8')).digest('hex');
const JAR_BYTES = Buffer.from('not really a zip, but bytes are bytes\n', 'utf8');
const JAR_SHA = createHash('sha256').update(JAR_BYTES).digest('hex');
const COMMIT = 'a'.repeat(40);
const HEAD_COMMIT = 'b'.repeat(40);

function tempDir(prefix = 'cp-jar-sidecar-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  test.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort: a leftover temp dir fails the assertion below, not the suite
    }
  });
  return dir;
}

/** A fake `spawnSync` that answers the four git calls the module makes. */
function fakeGit({ treeText = TREE_TEXT, headCommit = HEAD_COMMIT, dirty = false, diffOut = '', treeFails = false, headFails = false } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd !== 'git') return { status: 1, stdout: '', stderr: 'unexpected command' };
    if (args[0] === 'ls-tree') {
      return treeFails
        ? { status: 128, stdout: '', stderr: 'fatal: not a git repository' }
        : { status: 0, stdout: Buffer.from(treeText, 'utf8'), stderr: '' };
    }
    if (args[0] === 'rev-parse') {
      return headFails ? { status: 128, stdout: '', stderr: 'fatal: HEAD unknown' } : { status: 0, stdout: `${headCommit}\n`, stderr: '' };
    }
    if (args[0] === 'status') return { status: 0, stdout: dirty ? ' M packages/control-plane/pom.xml\n' : '', stderr: '' };
    if (args[0] === 'diff') return { status: 0, stdout: diffOut, stderr: '' };
    return { status: 1, stdout: '', stderr: `unexpected git ${args[0]}` };
  };
  return { run, calls };
}

function writeJar(dir, { name = 'control-plane-0.1.0.jar', bytes = JAR_BYTES } = {}) {
  const jarPath = join(dir, name);
  writeFileSync(jarPath, bytes);
  return jarPath;
}

function writeManifest(jarPath, overrides = {}) {
  const data = {
    schema: SIDECAR_SCHEMA,
    jarName: 'control-plane-0.1.0.jar',
    jarBytes: JAR_BYTES.length,
    jarSha256: JAR_SHA,
    commit: COMMIT,
    sourceTreeSha256: TREE_SHA,
    sourceScope: DEFAULT_SOURCE_SCOPE,
    builtAt: new Date(Date.now() + 1000).toISOString(),
    dirty: false,
    writtenBy: 'test',
    ...overrides,
  };
  const file = sidecarPathFor(jarPath);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { file, data };
}

test('T1: sidecar name/path are derived from the jar name (per-artifact, no collisions)', () => {
  assert.equal(sidecarFileName('control-plane-0.1.0.jar'), 'control-plane-0.1.0.jar.buildinfo.json');
  assert.equal(
    sidecarPathFor('C:/xihe-build/e2e/control-plane-0.1.0.jar').replaceAll('\\', '/'),
    'C:/xihe-build/e2e/control-plane-0.1.0.jar.buildinfo.json',
  );
  assert.match(sourceTreeSha256Command(), /^git ls-tree -r HEAD -- packages\/control-plane \| sha256sum$/);
});

test('T2: sha256 helpers hash bytes (known vectors)', () => {
  assert.equal(sha256Hex(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const dir = tempDir();
  const file = join(dir, 'f.bin');
  writeFileSync(file, Buffer.from('abc'));
  const result = sha256File(file);
  assert.deepEqual([result.ok, result.sha256, result.bytes], [true, sha256Hex('abc'), 3]);
});

test('T3: sha256File on a missing file is a failure, never a silent empty hash', () => {
  const result = sha256File(join(tmpdir(), 'definitely-not-here-bl477.jar'));
  assert.equal(result.ok, false);
  assert.equal(result.sha256, null);
  assert.match(result.error, /ENOENT|no such file/i);
});

test('T4: source tree hash covers the raw ls-tree bytes and counts entries', () => {
  const { run } = fakeGit();
  const ok = computeSourceTreeSha256({ projectDir: 'C:/proj', run });
  assert.equal(ok.ok, true);
  assert.equal(ok.sha256, TREE_SHA);
  assert.equal(ok.entries, 2);

  const failed = computeSourceTreeSha256({ projectDir: 'C:/proj', run: fakeGit({ treeFails: true }).run });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /not a git repository/);

  // An empty listing is not "no changes" — it means the scope/checkout is wrong.
  const empty = computeSourceTreeSha256({ projectDir: 'C:/proj', run: fakeGit({ treeText: '' }).run });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /listed no files/);
});

test('T5: buildSidecar records identity + provenance, and builtAt is the writer clock (never the jar mtime)', () => {
  // task-703 rewrote the second half of this test. It used to assert `builtAt === max(now, jar mtime)`
  // with the jar mtime in 2030, i.e. it **codified the laundering**: a future mtime became a legitimate
  // build time and the only trace was a WARN. `builtAt` is now the writer's own clock; a mtime ahead of
  // it is reported as skew, and beyond the tolerance it is refused outright (T25).
  const dir = tempDir();
  const jarPath = writeJar(dir);
  const jarMtimeMs = Date.UTC(2030, 0, 1);
  utimesSync(jarPath, jarMtimeMs / 1000, jarMtimeMs / 1000);
  const nowMs = jarMtimeMs - 1_000; // the mtime is 1 s ahead: inside the tolerance, so it is a real artifact
  const built = buildSidecar({
    projectDir: 'C:/proj',
    jarPath,
    writtenBy: 'scripts/e2e-host.mjs',
    now: () => nowMs,
    run: fakeGit().run,
  });
  assert.equal(built.ok, true);
  assert.equal(built.data.jarSha256, JAR_SHA);
  assert.equal(built.data.jarBytes, JAR_BYTES.length);
  assert.equal(built.data.commit, HEAD_COMMIT);
  assert.equal(built.data.sourceTreeSha256, TREE_SHA);
  assert.equal(built.data.dirty, false);
  assert.equal(built.data.writtenBy, 'scripts/e2e-host.mjs');
  // the laundering is gone: the manifest does not adopt the artifact's future mtime as its build time
  assert.equal(Date.parse(built.data.builtAt), nowMs);
  assert.notEqual(Date.parse(built.data.builtAt), jarMtimeMs);
  // …and the skew is reported instead of hidden
  assert.equal(built.clockSkewMs, 1_000);

  // when the clock is ahead of the artifact (the normal producer case) nothing is touched
  const ahead = buildSidecar({ projectDir: 'C:/proj', jarPath, now: () => jarMtimeMs + 5_000, run: fakeGit().run });
  assert.equal(Date.parse(ahead.data.builtAt), jarMtimeMs + 5_000);
  assert.equal(ahead.clockSkewMs, 0);
});

test('T6: buildSidecar refuses to write a manifest without HEAD or without a tree hash', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  const noHead = buildSidecar({ projectDir: 'C:/proj', jarPath, run: fakeGit({ headFails: true }).run });
  assert.equal(noHead.ok, false);
  assert.match(noHead.error, /git HEAD/);

  const noTree = buildSidecar({ projectDir: 'C:/proj', jarPath, run: fakeGit({ treeFails: true }).run });
  assert.equal(noTree.ok, false);
  assert.match(noTree.error, /source tree/);

  const noJar = buildSidecar({ projectDir: 'C:/proj', jarPath: join(dir, 'missing.jar') });
  assert.equal(noJar.ok, false);
  assert.match(noJar.error, /cannot stat the jar/);
});

test('T7: writeSidecarAtomic writes in field order and leaves no temp file behind', () => {
  const dir = tempDir();
  const file = join(dir, 'x.jar.buildinfo.json');
  const written = writeSidecarAtomic({ sidecarPath: file, data: { writtenBy: 't', jarSha256: JAR_SHA, schema: 1, extra: 'dropped' } });
  assert.equal(written.ok, true);
  const text = readFileSync(file, 'utf8');
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['schema', 'jarSha256', 'writtenBy']); // declared order, unknown key dropped
  assert.equal('extra' in parsed, false);
  assert.deepEqual(readdirSync(dir), ['x.jar.buildinfo.json']);
});

test('T8: a failed rename does not leave a temp file (no fake evidence on disk)', () => {
  const dir = tempDir();
  const file = join(dir, 'y.jar.buildinfo.json');
  const result = writeSidecarAtomic({
    sidecarPath: file,
    data: { schema: 1 },
    rename: () => {
      throw new Error('EXDEV: cross-device link not permitted');
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /EXDEV/);
  assert.deepEqual(readdirSync(dir), []);
});

test('T9: parseSidecar accepts a complete manifest and rejects every broken shape', () => {
  const good = {
    schema: SIDECAR_SCHEMA,
    jarName: 'control-plane-0.1.0.jar',
    jarBytes: 12,
    jarSha256: JAR_SHA,
    commit: COMMIT,
    sourceTreeSha256: TREE_SHA,
    sourceScope: DEFAULT_SOURCE_SCOPE,
    builtAt: '2026-11-08T05:00:00.000Z',
    dirty: false,
    writtenBy: 'scripts/e2e-host.mjs',
  };
  assert.equal(parseSidecar(JSON.stringify(good)).ok, true);

  const broken = {
    'not json': '{oops',
    'array root': '[]',
    'schema 2': JSON.stringify({ ...good, schema: 2 }),
    'short commit': JSON.stringify({ ...good, commit: 'abc1234' }),
    'bad jar hash': JSON.stringify({ ...good, jarSha256: 'zz' }),
    'bad tree hash': JSON.stringify({ ...good, sourceTreeSha256: JAR_SHA.toUpperCase() }),
    'bad builtAt': JSON.stringify({ ...good, builtAt: 'yesterday-ish' }),
    'dirty string': JSON.stringify({ ...good, dirty: 'false' }),
    'no writer': JSON.stringify({ ...good, writtenBy: '' }),
    'zero bytes': JSON.stringify({ ...good, jarBytes: 0 }),
  };
  for (const [name, text] of Object.entries(broken)) {
    const parsed = parseSidecar(text);
    assert.equal(parsed.ok, false, `must reject: ${name}`);
    assert.equal(typeof parsed.error, 'string');
  }
});

test('T10: readSidecar distinguishes missing from invalid (corrupt ≠ absent)', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  assert.equal(readSidecar({ jarPath }).state, 'missing');

  const { file } = writeManifest(jarPath);
  assert.equal(readSidecar({ jarPath }).state, 'ok');

  writeFileSync(file, '{ trunc', 'utf8');
  const invalid = readSidecar({ jarPath });
  assert.equal(invalid.state, 'invalid');
  assert.match(invalid.error, /not JSON/);

  // A manifest that exists but cannot be read is invalid, not absent (fail-closed).
  const denied = readSidecar({
    jarPath,
    readFile: () => {
      const error = new Error('EACCES: permission denied');
      error.code = 'EACCES';
      throw error;
    },
  });
  assert.equal(denied.state, 'invalid');
  assert.match(denied.error, /cannot read the sidecar/);

  // Genuine absence keeps flowing to the content-evidence path.
  const absent = readSidecar({
    jarPath,
    readFile: () => {
      const error = new Error('ENOENT: no such file');
      error.code = 'ENOENT';
      throw error;
    },
  });
  assert.equal(absent.state, 'missing');
});

test('T11: matching identity + matching tree ⇒ fresh (no per-file scan, no mtime)', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  writeManifest(jarPath);
  const verdict = evaluateSidecar({ jarPath, projectDir: 'C:/proj', run: fakeGit().run });
  assert.equal(verdict.state, 'fresh');
  assert.match(verdict.reason, /byte-identical/);
  assert.equal(verdict.data.jarSha256, JAR_SHA);
});

test('T12: identity ok but HEAD moved ⇒ stale, and the change count is reported', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  writeManifest(jarPath);
  const newerTree = `${TREE_TEXT}100644 blob cccc\tpackages/control-plane/src/main/java/New.java\n`;
  const { run } = fakeGit({ treeText: newerTree, diffOut: 'packages/control-plane/src/main/java/New.java\npackages/control-plane/pom.xml\n' });
  const verdict = evaluateSidecar({ jarPath, projectDir: 'C:/proj', run });
  assert.equal(verdict.state, 'stale');
  assert.equal(verdict.changedCount, 2);
  assert.match(verdict.reason, /was built from tree/);
});

test('T13: jar replaced behind the manifest ⇒ identity-mismatch (the strongest negative)', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  writeManifest(jarPath);
  writeFileSync(jarPath, Buffer.from('a plain `mvn package` overwrote me')); // same name, different bytes
  const verdict = evaluateSidecar({ jarPath, projectDir: 'C:/proj', run: fakeGit().run });
  assert.equal(verdict.state, 'identity-mismatch');
  assert.equal(verdict.expectedJarSha256, JAR_SHA);
  assert.notEqual(verdict.actualJarSha256, JAR_SHA);
  assert.match(verdict.reason, /but the jar on disk is/);

  // A sidecar copied from another jar name is the same failure, not "fresh".
  const dir2 = tempDir();
  const otherJar = writeJar(dir2, { name: 'control-plane-0.0.9.jar' });
  writeManifest(otherJar, { jarName: 'control-plane-0.1.0.jar' });
  const renamed = evaluateSidecar({ jarPath: otherJar, projectDir: 'C:/proj', run: fakeGit().run });
  assert.equal(renamed.state, 'identity-mismatch');
});

test('T14: unreadable manifest or unhashable jar ⇒ invalid (unverifiable), never fresh', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  const { file } = writeManifest(jarPath);
  writeFileSync(file, '{ truncated', 'utf8');
  const corrupt = evaluateSidecar({ jarPath, projectDir: 'C:/proj', run: fakeGit().run });
  assert.equal(corrupt.state, 'invalid');
  assert.match(corrupt.reason, /unusable/);

  const dir2 = tempDir();
  const jar2 = writeJar(dir2);
  writeManifest(jar2);
  const unreadable = evaluateSidecar({
    jarPath: jar2,
    projectDir: 'C:/proj',
    run: fakeGit().run,
    // Only the *jar* read fails: the manifest is fine, so this is "cannot prove identity".
    readFile: (file, encoding) => {
      if (encoding === 'utf8') return readFileSync(file, encoding);
      throw new Error('EACCES: permission denied');
    },
  });
  assert.equal(unreadable.state, 'invalid');
  assert.match(unreadable.reason, /cannot hash the jar/);
});

test('T15: degraded (not fresh, not stale) when the tree comparison is impossible', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);

  writeManifest(jarPath);
  const noGit = evaluateSidecar({ jarPath, projectDir: 'C:/proj', run: fakeGit({ headFails: true }).run });
  assert.equal(noGit.state, 'degraded');

  const noTree = evaluateSidecar({ jarPath, projectDir: 'C:/proj', run: fakeGit({ treeFails: true }).run });
  assert.equal(noTree.state, 'degraded');

  const dirtyNow = evaluateSidecar({ jarPath, projectDir: 'C:/proj', run: fakeGit({ dirty: true }).run });
  assert.equal(dirtyNow.state, 'degraded');
  assert.match(dirtyNow.reason, /uncommitted changes/);

  const builtDirty = (() => {
    const d = tempDir();
    const j = writeJar(d);
    writeManifest(j, { dirty: true });
    return evaluateSidecar({ jarPath: j, projectDir: 'C:/proj', run: fakeGit().run });
  })();
  assert.equal(builtDirty.state, 'degraded');
  assert.match(builtDirty.reason, /dirty tree/);
});

test('T16: reader priority maps onto scopes: fresh / build / artifact-truth / fallback', () => {
  const fallbackPayload = { verdict: 'stale', stale: [{ path: 'x' }] };
  let fallbackCalls = 0;
  const runFallback = () => {
    fallbackCalls += 1;
    return fallbackPayload;
  };

  const fresh = resolveArtifactTruth({ sidecar: { state: 'fresh' }, runFallback });
  assert.deepEqual([fresh.verdict, fresh.blocking, fresh.source, fresh.fallback], ['fresh', null, 'sidecar', null]);

  const staleTree = resolveArtifactTruth({ sidecar: { state: 'stale' }, runFallback });
  assert.deepEqual([staleTree.verdict, staleTree.blocking], ['stale', 'build'], 'ordinary staleness stays deferrable (pre-gate rebuild heals it)');

  const identity = resolveArtifactTruth({ sidecar: { state: 'identity-mismatch' }, runFallback });
  assert.deepEqual([identity.verdict, identity.blocking], ['stale', 'artifact-truth'], 'a jar that is not the fingerprinted one must never be deferred');

  const invalid = resolveArtifactTruth({ sidecar: { state: 'invalid' }, runFallback });
  assert.deepEqual([invalid.verdict, invalid.blocking], ['unverifiable', 'artifact-truth']);

  const missing = resolveArtifactTruth({ sidecar: { state: 'missing' }, runFallback });
  assert.deepEqual([missing.verdict, missing.source, missing.fallback], ['fallback', 'content', fallbackPayload]);

  const degraded = resolveArtifactTruth({ sidecar: { state: 'degraded' }, runFallback });
  assert.deepEqual([degraded.verdict, degraded.source], ['fallback', 'content']);

  // The fallback must be consulted for the two states that need it — and for no other state.
  assert.equal(fallbackCalls, 2);
  assert.throws(() => resolveArtifactTruth({ sidecar: { state: 'missing' } }), /needs runFallback/);
});

test('T17: countChangedSources counts lines and returns null (not 0) when git fails', () => {
  assert.equal(countChangedSources({ projectDir: 'C:/proj', fromCommit: COMMIT, scope: DEFAULT_SOURCE_SCOPE, run: fakeGit().run }), 0);
  assert.equal(
    countChangedSources({ projectDir: 'C:/proj', fromCommit: COMMIT, scope: DEFAULT_SOURCE_SCOPE, run: fakeGit({ diffOut: 'a\nb\nc\n' }).run }),
    3,
  );
  const failing = () => ({ status: 128, stdout: '', stderr: 'bad object' });
  assert.equal(countChangedSources({ projectDir: 'C:/proj', fromCommit: COMMIT, scope: DEFAULT_SOURCE_SCOPE, run: failing }), null);
  assert.equal(countChangedSources({ projectDir: 'C:/proj', fromCommit: 'nope', scope: DEFAULT_SOURCE_SCOPE, run: failing }), null);
});

test('T18: writeSidecarForJar is the one call producers need, and the result round-trips', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  const written = writeSidecarForJar({ projectDir: 'C:/proj', jarPath, writtenBy: 'scripts/e2e-host.mjs', run: fakeGit().run });
  assert.equal(written.ok, true);
  assert.equal(existsSync(written.file), true);
  const read = readSidecar({ jarPath });
  assert.equal(read.state, 'ok');
  assert.equal(read.data.jarSha256, JAR_SHA);
  assert.equal(read.data.commit, HEAD_COMMIT);
  // ordering invariant the card verifies on a real build: the manifest is not older than the jar
  assert.equal(Date.parse(read.data.builtAt) >= 0, true);
  assert.equal(read.data.builtAt, new Date(read.data.builtAt).toISOString());
});

test('T19: the manifest carries no absolute paths or host names (evidence is portable)', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  const written = writeSidecarForJar({ projectDir: 'C:/proj', jarPath, writtenBy: 'scripts/e2e-host.mjs', run: fakeGit().run });
  const text = readFileSync(written.file, 'utf8');
  assert.equal(/[A-Za-z]:[\\/]/.test(text), false, `sidecar leaked an absolute path: ${text}`);
  assert.equal(/\\/.test(text), false, 'sidecar leaked a Windows path separator');
  assert.equal(text.includes(dir), false);
});

test('T21: producer inventory — every producer stamps through ONE write point, and the gate reads it', () => {
  // Acceptance ①, made machine-checkable: the set of files that call `writeSidecarForJar` must be
  // exactly {the module that defines it, task-180's shared stamp}. The jar's two marks (in-jar
  // build-info + sidecar) are only ever written there, so a producer cannot stamp one without the
  // other — before task-180 each caller duplicated the sequence and the copy in the preflight
  // self-heal refreshed the stamp only, which left a new jar next to an old fingerprint.
  const scriptsDir = join(import.meta.dirname, '..');
  const files = readdirSync(scriptsDir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.mjs') && !rel.endsWith('.test.mjs'))
    .map((rel) => join(scriptsDir, rel));
  const callSites = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (/\bwriteSidecarForJar\(/u.test(text)) callSites.push(file.replaceAll('\\', '/').replace(/^.*?\/scripts\//u, 'scripts/'));
  }
  assert.deepEqual(callSites.sort(), ['scripts/lib/cp-artifact-stamp.mjs', 'scripts/lib/cp-jar-sidecar.mjs']);

  // …and the producers reach it only through that stamp (the regression task-180 fixed).
  const producers = {
    'e2e-host.mjs': 2, // rebuild branch + preflight self-heal
  };
  for (const [rel, expected] of Object.entries(producers)) {
    const text = readFileSync(join(scriptsDir, rel), 'utf8');
    const stamps = text.match(/stampCpArtifact\(\{/gu) ?? [];
    assert.equal(stamps.length, expected, `${rel} must route every jar write through stampCpArtifact`);
    assert.doesNotMatch(text, /\bwriteBuildInfo\(/u, `${rel} must not stamp build-info by hand`);
  }

  // …and the preflight must actually consume it, before the task-84 content path.
  const preflight = readFileSync(join(scriptsDir, 'e2e-preflight.mjs'), 'utf8');
  assert.match(preflight, /import \{ evaluateSidecar, resolveArtifactTruth \} from '\.\/lib\/cp-jar-sidecar\.mjs'/u);
  assert.match(preflight, /runFallback: \(\) => \{/u, 'the content-evidence path must remain the fallback');
  // task-42: the reader is called with the **shared sample**, so the gate judges the bytes the boot plan
  // already sampled instead of opening a second read (that gap was the self-heal branch's only trigger).
  const sidecarCall = preflight.indexOf('evaluateSidecar({ jarPath: cpJar.path, projectDir, sample: sharedSample })');
  const fallbackCall = preflight.indexOf('decideArtifactFreshness({');
  assert.ok(sidecarCall >= 0 && fallbackCall > sidecarCall, 'the sidecar is consulted before the per-file scan');
});

test('T20: a producer that cannot resolve git writes nothing at all (no half-truth on disk)', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  const written = writeSidecarForJar({ projectDir: 'C:/proj', jarPath, run: fakeGit({ headFails: true }).run });
  assert.equal(written.ok, false);
  assert.deepEqual(readdirSync(dir), ['control-plane-0.1.0.jar']);
});

test('T22: a manifest written long after the jar is refused (an after-the-fact claim would be a false green)', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  const old = Date.now() - 81 * 60_000;
  utimesSync(jarPath, old / 1000, old / 1000);
  const refused = writeSidecarForJar({ projectDir: 'C:/proj', jarPath, run: fakeGit().run });
  assert.equal(refused.ok, false);
  const seconds = Number(/written (\d+)s before now/u.exec(refused.error)?.[1]);
  assert.ok(Number.isFinite(seconds) && seconds >= 4800, `expected the real lag in the error: ${refused.error}`);
  assert.match(refused.error, /false green/u);
  // nothing half-written: the directory still holds only the jar
  assert.deepEqual(readdirSync(dir), ['control-plane-0.1.0.jar']);
});

test('T23: the write-lag window is a parameter — default accepts a producer tail, callers can widen it', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  const withinWindow = Date.now() - 30_000;
  utimesSync(jarPath, withinWindow / 1000, withinWindow / 1000);
  const ok = writeSidecarForJar({ projectDir: 'C:/proj', jarPath, run: fakeGit().run });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.jarSha256, JAR_SHA);
  assert.equal(ok.clockSkewMs, 0);

  const late = Date.now() - 5 * 60_000;
  utimesSync(jarPath, late / 1000, late / 1000);
  assert.equal(writeSidecarForJar({ projectDir: 'C:/proj', jarPath, run: fakeGit().run }).ok, false);
  const widened = writeSidecarForJar({ projectDir: 'C:/proj', jarPath, run: fakeGit().run, maxWriteLagMs: 10 * 60_000 });
  assert.equal(widened.ok, true);
});

test('T24: every mode that skips the artifact section says so out loud (a silent skip is the defect)', () => {
  // Ruling 2026-11-08: the three skip modes keep skipping (the frozen task-84 section layout is not
  // restructured), but they must announce the consequence in the run header — a green run whose
  // artifact section never executed is exactly the failure class BL-477 exists to stop.
  const preflight = readFileSync(join(import.meta.dirname, '..', 'e2e-preflight.mjs'), 'utf8');
  assert.match(preflight, /CP artifact section SKIPPED — \$\{cause\}/u, 'the skip must be a WARN naming the cause');
  assert.match(preflight, /identity is NOT verified, and nothing later re-checks it/u, 'and it must state that nobody re-checks');
  assert.match(preflight, /does NOT participate in this run/u, 'a neighbouring manifest must be declared irrelevant');
  assert.match(preflight, /XIHE_E2E_EXTERNAL_SERVER === '1'/u, 'external reuse is the one cause observable at this boundary');
  assert.match(preflight, /--jar-mode=use\|native/u, 'the other two modes are named (the runner collapses them into --ignore-build)');
  assert.doesNotMatch(preflight, /CP artifact freshness skipped \(--ignore-build\)/u, 'the old INFO line stated the skip but not the consequence');
});

// ── task-703: the write-lag guard was one-directional ──────────────────────────────────────────
// A jar mtime in the future made `writeLagMs` negative, so it could never exceed the limit; combined
// with `Math.max(now, mtime)` that turned "the producer touched the artifact forward" into a *clean*
// manifest for bytes that were never rebuilt. Measured in task-42 Run A (jar sha unchanged, 11 CP
// files behind HEAD). These cases are the regression net for both directions and for the content check.

test('task-703 ①: a jar whose mtime is in the future is refused outright (the guard now runs both ways)', () => {
  const dir = tempDir('xihe-sidecar-future-');
  const jarPath = writeJar(dir);
  const future = Date.now() + 5 * 60_000; // the exact shape of the Run A forgery: +5 min
  utimesSync(jarPath, future / 1000, future / 1000);
  const refused = writeSidecarForJar({ projectDir: 'C:/proj', jarPath, run: fakeGit().run });
  assert.equal(refused.ok, false, 'a future mtime must not be accepted just because the lag guard cannot see it');
  assert.match(refused.error, /mtime is \d+s later than the current time/u);
  assert.match(refused.error, /skip repackaging/u, 'the error must name the consequence, not only the anomaly');
  assert.match(refused.error, /false green/u, 'and must say why this is the false green the fingerprint exists to stop');
  // fail-closed: nothing half-written, and the reader keeps the OLD manifest (identity mismatch), never a green
  assert.deepEqual(readdirSync(dir), ['control-plane-0.1.0.jar']);
});

test('task-703 ①b: the refusal is about the mtime, not the clock — a normal producer still passes', () => {
  const dir = tempDir('xihe-sidecar-normal-');
  const jarPath = writeJar(dir); // mtime ≈ now, written by this test itself
  const built = writeSidecarForJar({ projectDir: 'C:/proj', jarPath, run: fakeGit().run });
  assert.equal(built.ok, true, built.error);
  assert.ok(built.clockSkewMs <= DEFAULT_MAX_FUTURE_MTIME_MS, `a just-written jar must sit inside the tolerance (skew ${built.clockSkewMs}ms)`);
});

test('task-703 ②: a future mtime inside the tolerance passes, and builtAt does NOT adopt it', () => {
  const dir = tempDir('xihe-sidecar-skew-');
  const jarPath = writeJar(dir);
  const nowMs = Date.now();
  const jarMtimeMs = nowMs + 1_000; // ahead, but within DEFAULT_MAX_FUTURE_MTIME_MS
  utimesSync(jarPath, jarMtimeMs / 1000, jarMtimeMs / 1000);
  const built = buildSidecar({ projectDir: 'C:/proj', jarPath, now: () => nowMs, run: fakeGit().run });
  assert.equal(built.ok, true);
  assert.equal(Date.parse(built.data.builtAt), nowMs, 'builtAt is the writer clock; the old Math.max laundered the artifact mtime into it');
  assert.equal(built.clockSkewMs, 1_000, 'the skew is reported instead of silently reordered');
});

test('task-703 ③: verifyJarRepackaged — unchanged bytes after a build is a refusal, changed bytes are proof', () => {
  const dir = tempDir('xihe-jar-repackage-');
  const jarPath = writeJar(dir);
  const before = sha256File(jarPath);
  assert.equal(before.ok, true);

  // The Run A shape: mvn exited 0 but maven-jar-plugin skipped the jar goal ⇒ same bytes.
  const stale = verifyJarRepackaged({ beforeSha256: before.sha256, jarPath, jarName: 'control-plane-0.1.0.jar', label: 'preflight 前自愈' });
  assert.equal(stale.ok, false, 'byte-identical after a "successful" build must not be treated as rebuilt');
  assert.match(stale.reason, /byte-identical to the artifact that existed before the build/u);
  assert.match(stale.reason, /maven-jar-plugin skipped repackaging/u);
  assert.match(stale.reason, /do NOT move the\s+mtime forward/u, 'and it must tell the operator what not to do again');
  assert.match(stale.reason, /preflight 前自愈:/u, 'the reason names which branch caught it');
  assert.equal(stale.skipped, false);

  // A real rebuild: the bytes differ ⇒ proof, not just a lack of complaint.
  writeFileSync(jarPath, Buffer.concat([JAR_BYTES, Buffer.from('repackaged\n', 'utf8')]));
  const fresh = verifyJarRepackaged({ beforeSha256: before.sha256, jarPath, jarName: 'control-plane-0.1.0.jar', label: 'rebuild' });
  assert.equal(fresh.ok, true, fresh.reason);
  assert.equal(fresh.skipped, false);
  assert.notEqual(fresh.afterSha256, before.sha256);

  // A first build has nothing to compare against — that is not a failure and must not be reported as one.
  const first = verifyJarRepackaged({ beforeSha256: null, jarPath });
  assert.equal(first.ok, true);
  assert.equal(first.skipped, true);

  // An artifact that cannot be hashed is unverifiable, which is a refusal (unknown is never green).
  const unhashable = verifyJarRepackaged({ beforeSha256: before.sha256, jarPath, sha256: () => ({ ok: false, error: 'EACCES' }) });
  assert.equal(unhashable.ok, false);
  assert.match(unhashable.reason, /cannot hash/u);
});

test('task-703 ③b: both e2e-host jar producers call the ONE content guard, before any mark is written', () => {
  // Requirement: the two producers must not grow two copies of this judgement (task-90 drifted that way).
  const host = readFileSync(join(import.meta.dirname, '..', 'e2e-host.mjs'), 'utf8');
  assert.match(host, /import \{[^}]*verifyJarRepackaged[^}]*\} from '\.\/lib\/cp-jar-sidecar\.mjs'/u, 'the guard comes from the lib, not a second local implementation');
  // The wrapper's own definition has the same opening, so count call sites, not textual matches:
  // exactly two producers must go through it (a third copy is how task-90 drifted).
  const calls = host.match(/(?<!function )assertJarRepackaged\(\{/gu) ?? [];
  assert.equal(calls.length, 2, 'exactly two producers: the rebuild branch and the preflight self-heal');
  const wrapperSites = host.match(/function assertJarRepackaged\(/gu) ?? [];
  assert.equal(wrapperSites.length, 1, 'both sites go through one wrapper');

  // The wrapper must be a FAIL-FAST, not a warning that lets the run continue onto stale bytes.
  const wrapper = host.slice(host.indexOf('function assertJarRepackaged('), host.indexOf('function assertJarRepackaged(') + 1200);
  assert.match(wrapper, /console\.error\(`\[e2e-host\] FAIL-FAST: \$\{checked\.reason\}`\)/u);
  assert.match(wrapper, /process\.exit\(1\)/u, 'sha unchanged ⇒ non-zero exit');
  assert.match(wrapper, /jar bytes changed after the build/u, 'a genuine rebuild is logged as proof');

  // Ordering: at each site the content check must come **before** stampCpArtifact, otherwise the false
  // manifest is already on disk by the time the bytes are examined.
  for (const anchor of ["label: 'rebuild'", "label: 'preflight 前自愈'"]) {
    const at = host.indexOf(anchor);
    assert.ok(at >= 0, `anchor ${anchor} missing`);
    const stampAt = host.indexOf('stampCpArtifact({', at);
    assert.ok(stampAt > at, `${anchor}: the stamp must follow the content guard`);
  }

  // The pre-build hash must come from the shared sample, so this adds no second read of the artifact.
  assert.match(host, /beforeSha256: bootPlanSnapshot\?\.jarSha256/u, 'the rebuild site reuses the boot-plan sample');
  assert.match(host, /beforeSha256: snapshot\?\.jarSha256/u, 'the self-heal site reuses the same shared sample');
});

test('task-703 ③c: the byte requirement is keyed to why the build ran (no new false red for a forced no-op rebuild)', () => {
  // The guard must catch Run A (content behind HEAD ⇒ the bytes had to move) without inventing a
  // failure for `--jar-mode=rebuild` on an already-current tree, where mvn legitimately produces the
  // same artifact. That distinction is `requireChange`, and it is driven by the branch's own stale flag.
  const host = readFileSync(join(import.meta.dirname, '..', 'e2e-host.mjs'), 'utf8');
  const rebuildAt = host.indexOf("label: 'rebuild',");
  assert.ok(rebuildAt > 0, "the rebuild site's label must exist");
  const rebuildSite = host.slice(rebuildAt, rebuildAt + 400);
  // Keyed to the reader's verdict, not to the mtime flag: a forged future mtime leaves `staleByMtime`
  // false while the tree is still behind HEAD, so an mtime-keyed exemption would reopen Run A here.
  assert.match(rebuildSite, /requireChange: bootPlanJudgement\.shared\.verdict !== 'fresh'/u, "the rebuild site requires new bytes unless the pre-build sample was judged fresh");
  assert.match(host, /const bootPlanJudgement = selfHealIsNeeded\(bootPlanSnapshot\)/u, 'the judgement comes from the same single-sample reader');
  const healSite = host.slice(host.indexOf("label: 'preflight 前自愈',"));
  assert.match(healSite, /requireChange: true/u, 'the self-heal branch always requires new bytes — it only runs when content says the jar is behind');

  // `requireChange: false` must be an explicit, logged pass-through — never a silent skip.
  const wrapper = host.slice(host.indexOf('function assertJarRepackaged('), host.indexOf('// R2 decision table'));
  assert.match(wrapper, /if \(!requireChange\) \{[\s\S]*?console\.log\(/u, 'a skipped check must be announced');
  assert.match(wrapper, /return \{ ok: true, reason: null, skipped: true \}/u, 'and it reports skipped, not verified');
});

test('task-703 ④: the tightening added no bypass and lowered no existing threshold', () => {
  // Requirement 6 — the judgement is stricter, never configurable away.
  assert.equal(DEFAULT_MAX_WRITE_LAG_MS, 120_000, 'the lag limit must not have been loosened');
  assert.equal(DEFAULT_MAX_FUTURE_MTIME_MS, 2_000, 'the future window is a tolerance, not an invitation');
  const sidecar = readFileSync(join(import.meta.dirname, 'cp-jar-sidecar.mjs'), 'utf8');
  // Assert on **code**, not prose: the docblock names the removed expression precisely to explain why
  // it was wrong, so a whole-file match would fail on the explanation of the fix.
  const code = sidecar
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /allowFutureMtime|ignoreFutureMtime|skipFutureCheck/u, 'no escape-hatch flag may exist');
  assert.doesNotMatch(code, /maxFutureMtimeMs\s*=\s*(Infinity|Number\.POSITIVE_INFINITY|0\s*\/\s*0)/u, 'the future window cannot be disabled by its default');
  assert.doesNotMatch(code, /Math\.max\(nowMs,\s*jarMtimeMs\)/u, 'the laundering expression must be gone from the code');
  const host = readFileSync(join(import.meta.dirname, '..', 'e2e-host.mjs'), 'utf8');
  assert.doesNotMatch(host, /forceCreation/u, 'the rejected alternative must not have been smuggled in');
});

test('task-703: the stale "forging is impossible" comments are gone (an out-of-date comment is worse than none)', () => {
  const sidecar = readFileSync(join(import.meta.dirname, 'cp-jar-sidecar.mjs'), 'utf8');
  const stamp = readFileSync(join(import.meta.dirname, 'cp-artifact-stamp.mjs'), 'utf8');
  assert.match(sidecar, /one-directional and that was a defect \(task-703\)/u, 'the docblock must state the gap it now closes');
  assert.match(stamp, /This ordering is NOT a forge-proof|not a safety property on its own/u, 'the stamp module must stop claiming write ordering proves content');
  assert.doesNotMatch(stamp, /so a\s+\n?\s*\/\/?\s*manifest can never be forged onto an artifact from an earlier build/u);
  assert.doesNotMatch(stamp, /so `builtAt` can never predate the artifact it describes/u, 'that sentence was the false security claim');
  assert.doesNotMatch(stamp, /builtAt was clamped by/u, 'the WARN must not claim a clamp that no longer happens');
});
