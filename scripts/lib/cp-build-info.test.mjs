/**
 * PLAN-0662 L1/L2 unit tests: the build stamp and the freshness verdict the launcher acts on.
 *
 * Why these matter: the gate's whole value is the `stale → rebuild` decision. If the verdict is
 * wrong in the safe direction it only costs a compile; if it is wrong in the unsafe direction the
 * resident stack silently serves pre-fix classes again (BL-240). So the decision is a pure
 * function and every branch — fresh / stale / missing stamp / unknown HEAD / short sha — is
 * pinned here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildInfoPath,
  cpTargetDir,
  evaluateCpFreshness,
  formatBuildInfo,
  gitHead,
  parseBuildInfo,
  readBuildInfo,
  sameCommit,
  shortSha,
  writeBuildInfo,
} from './cp-build-info.mjs';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function tempTarget(t) {
  const directory = mkdtempSync(join(tmpdir(), 'xihe-cp-build-info-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('parseBuildInfo reads the three stamp fields and ignores comments and blanks', () => {
  const parsed = parseBuildInfo(
    ['# generated', 'commit=abc123', '', '! note', 'builtAt=2026-11-04T20:00:00.000Z', 'dirty=true', ''].join(
      '\n',
    ),
  );
  assert.deepEqual(parsed, {
    commit: 'abc123',
    builtAt: '2026-11-04T20:00:00.000Z',
    dirty: true,
  });
});

test('parseBuildInfo rejects a file without a commit (not a stamp)', () => {
  assert.equal(parseBuildInfo('builtAt=whatever\ndirty=false\n'), null);
  assert.equal(parseBuildInfo(''), null);
  assert.equal(parseBuildInfo(undefined), null);
});

test('formatBuildInfo round-trips through parseBuildInfo', () => {
  const input = { commit: HEAD_A, builtAt: '2026-11-04T21:00:00.000Z', dirty: false };
  assert.deepEqual(parseBuildInfo(formatBuildInfo(input)), input);
  assert.match(formatBuildInfo(input), /\ncommit=a{40}\n/);
  assert.match(formatBuildInfo(input), /\ndirty=false\n/);
});

test('cpTargetDir follows XIHE_CP_TARGET_DIR and falls back to the pom default', () => {
  assert.equal(
    cpTargetDir({ projectRoot, env: {} }),
    join(projectRoot, 'packages', 'control-plane', 'target'),
  );
  assert.equal(
    cpTargetDir({ projectRoot, env: { XIHE_CP_TARGET_DIR: 'C:/xihe-build/dev-host' } }),
    resolve('C:/xihe-build/dev-host'),
  );
  // Relative override resolves against the checkout, never the cwd.
  assert.equal(
    cpTargetDir({ projectRoot, env: { XIHE_CP_TARGET_DIR: 'out/cp-target' } }),
    resolve(projectRoot, 'out/cp-target'),
  );
  assert.equal(cpTargetDir({ projectRoot, env: { XIHE_CP_TARGET_DIR: '   ' } }), join(projectRoot, 'packages', 'control-plane', 'target'));
});

test('buildInfoPath pins the classes/META-INF location', () => {
  assert.equal(
    buildInfoPath(join(projectRoot, 'target')),
    join(projectRoot, 'target', 'classes', 'META-INF', 'build-info.properties'),
  );
});

test('sameCommit accepts full, short and mismatched shas', () => {
  assert.equal(sameCommit(HEAD_A, HEAD_A), true);
  assert.equal(sameCommit(HEAD_A, HEAD_A.slice(0, 12)), true, 'historical short stamp still verifies');
  assert.equal(sameCommit(HEAD_A, HEAD_B), false);
  assert.equal(sameCommit(HEAD_A, ''), false);
  assert.equal(sameCommit(null, HEAD_A), false);
  assert.equal(sameCommit(HEAD_A, 'zzzzzzz'), false);
});

test('evaluateCpFreshness: fresh only when the stamp equals HEAD', () => {
  const targetDir = join(projectRoot, 'target-fresh-test');
  const read = () => formatBuildInfo({ commit: HEAD_A, builtAt: '2026-11-04T21:00:00.000Z', dirty: false });
  const fresh = evaluateCpFreshness({ targetDir, headCommit: HEAD_A, read });
  assert.equal(fresh.status, 'fresh');
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.fileCommit, HEAD_A);
  assert.equal(fresh.dirty, false);

  const stale = evaluateCpFreshness({ targetDir, headCommit: HEAD_B, read });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.fresh, false);
  assert.match(stale.reason, /!=/);

  const shortStamp = evaluateCpFreshness({
    targetDir,
    headCommit: HEAD_A,
    read: () => formatBuildInfo({ commit: HEAD_A.slice(0, 7), builtAt: '', dirty: true }),
  });
  assert.equal(shortStamp.status, 'fresh', 'a short stamp still proves the same commit');
  assert.equal(shortStamp.dirty, true);
});

test('evaluateCpFreshness: no stamp and unknown HEAD are never "fresh"', () => {
  const missing = evaluateCpFreshness({
    targetDir: join(projectRoot, 'target-never-built'),
    headCommit: HEAD_A,
    read: () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.fresh, false);

  const unverified = evaluateCpFreshness({
    targetDir: join(projectRoot, 'target-unverified'),
    headCommit: null,
    read: () => formatBuildInfo({ commit: HEAD_A, builtAt: '', dirty: false }),
  });
  assert.equal(unverified.status, 'unverified');
  assert.equal(unverified.fresh, false);
  assert.equal(unverified.fileCommit, HEAD_A);
});

test('writeBuildInfo creates classes/META-INF and stamps HEAD', (t) => {
  const targetDir = tempTarget(t);
  const file = writeBuildInfo({
    targetDir,
    commit: HEAD_A,
    builtAt: '2026-11-04T21:30:00.000Z',
    dirty: true,
  });
  assert.equal(file, buildInfoPath(targetDir));
  const { info } = readBuildInfo(targetDir);
  assert.deepEqual(info, { commit: HEAD_A, builtAt: '2026-11-04T21:30:00.000Z', dirty: true });
  // The stamp the launcher writes must satisfy its own gate.
  assert.equal(evaluateCpFreshness({ targetDir, headCommit: HEAD_A }).status, 'fresh');
});

test('shortSha is display-only and never truncates a short value oddly', () => {
  assert.equal(shortSha(HEAD_A), 'a'.repeat(12));
  assert.equal(shortSha('abc123'), 'abc123');
  assert.equal(shortSha(null), '');
});

test('gitHead yields a full 40-char sha for this checkout', () => {
  const head = gitHead({ cwd: projectRoot });
  assert.equal(head.error, null, head.error ?? '');
  assert.match(head.commit, /^[0-9a-f]{40}$/u);
  assert.equal(typeof head.dirty, 'boolean');
});
