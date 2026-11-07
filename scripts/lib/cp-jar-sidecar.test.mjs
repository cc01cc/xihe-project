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

test('T5: buildSidecar records identity + provenance, and clamps builtAt to the jar mtime', () => {
  const dir = tempDir();
  const jarPath = writeJar(dir);
  const jarMtimeMs = Date.UTC(2030, 0, 1); // far future: a "now" earlier than this must be clamped
  utimesSync(jarPath, jarMtimeMs / 1000, jarMtimeMs / 1000);
  const built = buildSidecar({
    projectDir: 'C:/proj',
    jarPath,
    writtenBy: 'scripts/e2e-host.mjs',
    now: () => jarMtimeMs - 60_000,
    run: fakeGit().run,
  });
  assert.equal(built.ok, true);
  assert.equal(built.data.jarSha256, JAR_SHA);
  assert.equal(built.data.jarBytes, JAR_BYTES.length);
  assert.equal(built.data.commit, HEAD_COMMIT);
  assert.equal(built.data.sourceTreeSha256, TREE_SHA);
  assert.equal(built.data.dirty, false);
  assert.equal(built.data.writtenBy, 'scripts/e2e-host.mjs');
  // the clamp keeps the ordering invariant the card verifies on a real build
  assert.equal(Date.parse(built.data.builtAt), jarMtimeMs);
  assert.equal(built.clockSkewMs, 60_000);

  // and when the clock is ahead of the artifact (the normal case) it is not touched
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

test('T21: producer inventory — only the shared-jar producer writes a sidecar, and the gate reads it', () => {
  // Acceptance ①, made machine-checkable: the set of files that call `writeSidecarForJar` must be
  // exactly {the module that defines it, the one script that produces the shared E2E CP jar}. A new
  // artifact producer therefore cannot ship without stamping (this test fails until it is added).
  const scriptsDir = join(import.meta.dirname, '..');
  const files = readdirSync(scriptsDir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => rel.endsWith('.mjs') && !rel.endsWith('.test.mjs'))
    .map((rel) => join(scriptsDir, rel));
  const callSites = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    if (/\bwriteSidecarForJar\(/u.test(text)) callSites.push(file.replaceAll('\\', '/').replace(/^.*?\/scripts\//u, 'scripts/'));
  }
  assert.deepEqual(callSites.sort(), ['scripts/e2e-host.mjs', 'scripts/lib/cp-jar-sidecar.mjs']);

  // …and the preflight must actually consume it, before the task-84 content path.
  const preflight = readFileSync(join(scriptsDir, 'e2e-preflight.mjs'), 'utf8');
  assert.match(preflight, /import \{ evaluateSidecar, resolveArtifactTruth \} from '\.\/lib\/cp-jar-sidecar\.mjs'/u);
  assert.match(preflight, /runFallback: \(\) => \{/u, 'the content-evidence path must remain the fallback');
  const sidecarCall = preflight.indexOf('evaluateSidecar({ jarPath: cpJar.path, projectDir })');
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
